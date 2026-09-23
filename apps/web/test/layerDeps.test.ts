import { describe, expect, it } from 'vitest';
import {
  ARCHIVED_BLOCKED_REASON,
  CYCLE_BLOCKED_REASON,
  buildCandidateGroups,
  filterCandidateGroups,
  predecessorIdsOf,
  readDependencyEditing,
  sameDependencySet,
  successorClosure,
} from '../src/domain/layerDeps';
import type { ScheduleEdge, ScheduleNode } from '../src/api/types';

/** 只写用例关心的字段：依赖图里一条边只由两端决定。 */
function edge(predecessorId: string, successorId: string): ScheduleEdge {
  return { predecessorId, successorId, critical: false };
}

/** 候选/节点的归档状态。 */
function node(id: string, archived = false) {
  return { id, archivedAt: archived ? '2026-09-22T00:00:00.000Z' : null };
}

/** 依赖图节点。时间参数与用例无关，一律给 0。 */
function scheduleNode(id: string, columnId: string, overrides: Partial<ScheduleNode> = {}): ScheduleNode {
  return {
    id,
    title: `任务 ${id}`,
    columnId,
    durationMinutes: null,
    archivedAt: null,
    earliestStart: 0,
    earliestFinish: 0,
    latestStart: 0,
    latestFinish: 0,
    slack: 0,
    critical: false,
    ...overrides,
  };
}

describe('predecessorIdsOf', () => {
  it('只取指向该任务的边，并按 id 升序（与后端响应口径一致）', () => {
    const edges = [edge('c', 't'), edge('a', 't'), edge('t', 'x'), edge('b', 'y')];

    expect(predecessorIdsOf(edges, 't')).toEqual(['a', 'c']);
  });

  it('没有前置时是空数组', () => {
    expect(predecessorIdsOf([edge('a', 'b')], 'a')).toEqual([]);
  });
});

describe('successorClosure', () => {
  it('含直接与间接后继，但不含自己', () => {
    // t → b → c，另有无关的 x → y
    const edges = [edge('t', 'b'), edge('b', 'c'), edge('x', 'y')];

    expect([...successorClosure(edges, 't')].sort()).toEqual(['b', 'c']);
  });

  it('分叉与汇合都算到', () => {
    const edges = [edge('t', 'b'), edge('t', 'c'), edge('b', 'd'), edge('c', 'd')];

    expect([...successorClosure(edges, 't')].sort()).toEqual(['b', 'c', 'd']);
  });

  it('库里已经有环（脏数据）时也能终止，并把环上的节点都算进来', () => {
    const edges = [edge('t', 'b'), edge('b', 'c'), edge('c', 'b')];

    expect([...successorClosure(edges, 't')].sort()).toEqual(['b', 'c']);
  });

  it('没有后继时是空集合', () => {
    expect(successorClosure([edge('a', 't')], 't').size).toBe(0);
  });
});

describe('sameDependencySet', () => {
  it('与顺序无关', () => {
    expect(sameDependencySet(['b', 'a'], ['a', 'b'])).toBe(true);
  });

  it('多一个、少一个、换一个都算不同', () => {
    expect(sameDependencySet(['a'], ['a', 'b'])).toBe(false);
    expect(sameDependencySet(['a', 'b'], ['a'])).toBe(false);
    expect(sameDependencySet(['a'], ['b'])).toBe(false);
  });

  it('两边都为空算相同', () => {
    expect(sameDependencySet([], [])).toBe(true);
  });

  it('重复项按集合语义处理：a,a 与 a,b 不同，与单个 a 相同', () => {
    // 逐项 includes + 长度比较会把第一对误判成相同（长度都是 2）。
    expect(sameDependencySet(['a', 'a'], ['a', 'b'])).toBe(false);
    expect(sameDependencySet(['a', 'a'], ['a'])).toBe(true);
  });
});

describe('readDependencyEditing', () => {
  it('草稿是未归档的当前前置；已归档的前置单独列出，不进草稿', () => {
    // t 的前置是 a（在）与 gone（已归档）
    const edges = [edge('a', 't'), edge('gone', 't'), edge('t', 'b')];
    const nodes = [node('t'), node('a'), node('b'), node('gone', true)];

    const editing = readDependencyEditing('t', edges, nodes);

    expect(editing.selectedIds).toEqual(['a']);
    expect(editing.archivedPredecessorIds).toEqual(['gone']);
  });

  it('会成环的候选标出来：直接依赖本任务与间接经过别人的都算', () => {
    // t → b → c；b、c 都不能再加成 t 的前置，d 可以
    const edges = [edge('t', 'b'), edge('b', 'c')];
    const nodes = [node('t'), node('b'), node('c'), node('d')];

    const { blockedReasonById } = readDependencyEditing('t', edges, nodes);

    expect(blockedReasonById.get('b')).toBe(CYCLE_BLOCKED_REASON);
    expect(blockedReasonById.get('c')).toBe(CYCLE_BLOCKED_REASON);
    expect(blockedReasonById.has('d')).toBe(false);
  });

  it('经过归档节点的环也算：存档不等于从图上消失', () => {
    // t → gone（已归档）→ b，所以 b 仍然不能选
    const edges = [edge('t', 'gone'), edge('gone', 'b')];
    const nodes = [node('t'), node('gone', true), node('b')];

    const { blockedReasonById } = readDependencyEditing('t', edges, nodes);

    expect(blockedReasonById.get('b')).toBe(CYCLE_BLOCKED_REASON);
  });

  it('已归档的候选标成「已归档」而不是环', () => {
    const edges = [edge('t', 'arch')];
    const nodes = [node('t'), node('arch', true)];

    const { blockedReasonById } = readDependencyEditing('t', edges, nodes);

    expect(blockedReasonById.get('arch')).toBe(ARCHIVED_BLOCKED_REASON);
  });

  it('自己不出现在候选原因表里', () => {
    const { blockedReasonById } = readDependencyEditing('t', [], [node('t')]);

    expect(blockedReasonById.has('t')).toBe(false);
  });
});

describe('buildCandidateGroups', () => {
  const columns = [
    { id: 'todo', name: '待办' },
    { id: 'doing', name: '进行中' },
  ];

  it('排除自己，按节点的顺序分组，列名从 columns 查', () => {
    const nodes = [
      scheduleNode('t', 'todo'),
      scheduleNode('z', 'todo'),
      scheduleNode('a', 'doing'),
    ];

    const groups = buildCandidateGroups(nodes, columns, 't', new Map(), []);

    expect(groups.map((group) => group.columnName)).toEqual(['待办', '进行中']);
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(['z']);
    expect(groups[1]?.rows.map((row) => row.id)).toEqual(['a']);
  });

  it('标出已选与不能选的原因；能选的行没有被禁用的原因', () => {
    const nodes = [scheduleNode('a', 'doing'), scheduleNode('b', 'doing')];
    const blocked = new Map([['b', CYCLE_BLOCKED_REASON]]);

    const groups = buildCandidateGroups(nodes, columns, 't', blocked, ['a']);
    const rows = groups.flatMap((group) => group.rows);

    expect(rows.find((row) => row.id === 'a')).toMatchObject({ selected: true, blockedReason: null });
    expect(rows.find((row) => row.id === 'b')).toMatchObject({
      selected: false,
      blockedReason: CYCLE_BLOCKED_REASON,
    });
  });

  it('列名查不到时退化成 columnId，而不是丢掉整组', () => {
    const groups = buildCandidateGroups([scheduleNode('a', 'weird')], columns, 't', new Map(), []);

    expect(groups[0]).toMatchObject({ columnId: 'weird', columnName: 'weird' });
  });

  it('没有别的任务时是空数组', () => {
    expect(buildCandidateGroups([scheduleNode('t', 'todo')], columns, 't', new Map(), [])).toEqual([]);
  });
});

describe('filterCandidateGroups', () => {
  const groups = [
    { columnId: 'todo', columnName: '待办', rows: [
      { id: 'a', title: '登录接口联调', durationMinutes: null, selected: false, blockedReason: null },
      { id: 'b', title: '支付对账', durationMinutes: null, selected: false, blockedReason: null },
    ] },
    { columnId: 'doing', columnName: '进行中', rows: [
      { id: 'c', title: '重构登录', durationMinutes: null, selected: false, blockedReason: null },
    ] },
  ];

  it('空关键词（含只有空白）原样返回', () => {
    expect(filterCandidateGroups(groups, '')).toEqual(groups);
    expect(filterCandidateGroups(groups, '   ')).toEqual(groups);
  });

  it('按标题过滤，命中的组留下、没命中的组整个去掉', () => {
    const filtered = filterCandidateGroups(groups, '登录');

    expect(filtered.map((group) => group.columnId)).toEqual(['todo', 'doing']);
    expect(filtered[0]?.rows.map((row) => row.id)).toEqual(['a']);
    expect(filtered[1]?.rows.map((row) => row.id)).toEqual(['c']);
  });

  it('大小写不敏感', () => {
    const withLatin = [
      { columnId: 'todo', columnName: '待办', rows: [
        { id: 'a', title: 'OAuth 回调', durationMinutes: null, selected: false, blockedReason: null },
      ] },
    ];

    expect(filterCandidateGroups(withLatin, 'oauth')[0]?.rows).toHaveLength(1);
  });

  it('一个都没命中时是空数组', () => {
    expect(filterCandidateGroups(groups, '不存在')).toEqual([]);
  });
});
