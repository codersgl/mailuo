import { describe, expect, it } from 'vitest';
import {
  ancestorIds,
  buildTree,
  countChildren,
  expandAncestors,
  toggleCollapsed,
} from '../src/lib/tree';
import type { TreeTask } from '../src/api/types';

function task(
  id: string,
  parentId: string | null = null,
  options: { columnId?: string; archivedAt?: string | null } = {},
): TreeTask {
  return {
    id,
    parentId,
    title: `任务 ${id}`,
    columnId: options.columnId ?? 'todo',
    archivedAt: options.archivedAt ?? null,
  };
}

/** 后端按 (parent_id, orders) 排序返回，这里照同样的顺序喂进去。 */
const flat: TreeTask[] = [
  task('a'), // 根
  task('b'), // 根
  task('a1', 'a'),
  task('a2', 'a'),
  task('a1x', 'a1'),
];

describe('buildTree', () => {
  it('按 parentId 组装层级，并保持后端给的顺序', () => {
    const roots = buildTree(flat);

    expect(roots.map((node) => node.task.id)).toEqual(['a', 'b']);
    expect(roots[0]!.children.map((node) => node.task.id)).toEqual(['a1', 'a2']);
    expect(roots[0]!.children[0]!.children.map((node) => node.task.id)).toEqual(['a1x']);
    expect(roots[1]!.children).toEqual([]);
  });

  it('父节点不在结果里时把它当顶层，而不是丢掉', () => {
    // 「显示已归档」关着时可能出现：父任务已归档，某个子任务没归档（只可能来自手工改库）。
    const roots = buildTree([task('x'), task('orphan', 'missing-parent')]);

    expect(roots.map((node) => node.task.id)).toEqual(['x', 'orphan']);
  });

  it('空列表得到空树', () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe('ancestorIds', () => {
  it('给出从根到父级的 id 链', () => {
    expect(ancestorIds(flat, 'a1x')).toEqual(['a', 'a1']);
  });

  it('顶层任务没有祖先', () => {
    expect(ancestorIds(flat, 'a')).toEqual([]);
  });

  it('任务不在列表里时返回空链', () => {
    expect(ancestorIds(flat, 'missing')).toEqual([]);
  });

  it('遇到成环的脏数据不会死循环', () => {
    const cyclic = [task('p', 'q'), task('q', 'p')];

    expect(ancestorIds(cyclic, 'p')).toEqual(['q']);
  });
});

describe('countChildren', () => {
  function node(id: string, children: TreeTask[]) {
    return buildTree([task(id), ...children])[0]!;
  }

  it('分母是直接子任务数，分子是其中完成列的数量', () => {
    const tree = node('p', [
      task('c1', 'p', { columnId: 'done' }),
      task('c2', 'p', { columnId: 'doing' }),
      task('c3', 'p', { columnId: 'done' }),
    ]);

    expect(countChildren(tree)).toEqual({ total: 3, done: 2 });
  });

  it('已归档的子任务不计入，所以打开「显示已归档」不改变徽标', () => {
    const withArchived = node('p', [
      task('c1', 'p', { columnId: 'done' }),
      task('c2', 'p', { columnId: 'done', archivedAt: '2026-09-22T00:00:00.000Z' }),
    ]);

    expect(countChildren(withArchived)).toEqual({ total: 1, done: 1 });
  });

  it('叶子节点是 0/0', () => {
    expect(countChildren(node('p', []))).toEqual({ total: 0, done: 0 });
  });

  it('只数直接子任务，不下钻', () => {
    const tree = node('p', [task('c1', 'p', { columnId: 'done' }), task('c1x', 'c1')]);

    expect(countChildren(tree)).toEqual({ total: 1, done: 1 });
  });
});

describe('toggleCollapsed', () => {
  it('折叠与展开是同一个操作的两面', () => {
    expect(toggleCollapsed([], 'a')).toEqual(['a']);
    expect(toggleCollapsed(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('expandAncestors', () => {
  it('把给定 id 从折叠集合里去掉', () => {
    expect(expandAncestors(['a', 'b', 'c'], ['b', 'c'])).toEqual(['a']);
  });

  it('没有变化时返回原数组，避免每次渲染都产生新状态', () => {
    const collapsed = ['a'];

    expect(expandAncestors(collapsed, ['x'])).toBe(collapsed);
  });
});
