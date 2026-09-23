import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../src/api/types';
import {
  MAX_QUERY_LENGTH,
  flattenGroups,
  formatResultPath,
  groupByColumn,
  groupStarts,
  moveSelection,
} from '../src/domain/search';

const columns = [
  { id: 'todo', name: '待办' },
  { id: 'doing', name: '进行中' },
  { id: 'done', name: '完成' },
];

function result(id: string, columnId: string): SearchResult {
  return {
    id,
    title: `任务 ${id}`,
    snippet: null,
    columnId,
    durationMinutes: null,
    archivedAt: null,
    path: [],
  };
}

describe('groupByColumn', () => {
  it('按列分组，组顺序跟看板的列顺序，不是命中的先来后到', () => {
    const groups = groupByColumn(
      [result('a', 'done'), result('b', 'todo'), result('c', 'done')],
      columns,
    );

    expect(groups.map((group) => [group.columnId, group.columnName])).toEqual([
      ['todo', '待办'],
      ['done', '完成'],
    ]);
    expect(groups[1]?.results.map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('没有命中的列不出现', () => {
    const groups = groupByColumn([result('b', 'todo')], columns);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.columnId).toBe('todo');
  });

  it('结果为空时没有分组', () => {
    expect(groupByColumn([], columns)).toEqual([]);
  });

  it('列里认不出的 columnId 不会凭空造出一组', () => {
    // 列由后端写死（todo/doing/done），认不出只可能是脏数据。丢掉它，不要让界面上多出一组无名任务。
    expect(groupByColumn([result('x', 'unknown')], columns)).toEqual([]);
  });
});

describe('MAX_QUERY_LENGTH', () => {
  it('就是 100：后端 apps/api/src/domain/search.ts 里有同一个数，两边各自钉一遍', () => {
    // 这个数决定了搜索框的 maxLength。漂移了不会报错，只会让用户敲到一半被后端回 400。
    expect(MAX_QUERY_LENGTH).toBe(100);
  });
});

describe('groupStarts', () => {
  it('给出每组在摊平顺序里的起点，与 flattenGroups 的下标一一对应', () => {
    const groups = groupByColumn(
      [result('a', 'todo'), result('b', 'done'), result('c', 'done')],
      columns,
    );

    expect(groupStarts(groups)).toEqual([0, 1]);
    // 起点要能对回摊平后的那一条：第一组第 0 条是 a，第二组第 0 条是 b。
    expect(flattenGroups(groups)[groupStarts(groups)[1]!]?.id).toBe('b');
  });

  it('结果为空时没有起点', () => {
    expect(groupStarts([])).toEqual([]);
  });
});

describe('flattenGroups', () => {
  it('摊平后的顺序就是渲染顺序：键盘 ↑↓ 走的就是它', () => {
    const groups = groupByColumn(
      [result('a', 'todo'), result('b', 'done'), result('c', 'todo')],
      columns,
    );

    expect(flattenGroups(groups).map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('moveSelection', () => {
  it('在范围内上下移动', () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, -1, 3)).toBe(1);
  });

  it('到顶或到底就停住，不环绕', () => {
    expect(moveSelection(0, -1, 3)).toBe(0);
    expect(moveSelection(2, 1, 3)).toBe(2);
  });

  it('结果为空时返回 -1，Enter 因此不会误开某一条', () => {
    expect(moveSelection(0, 1, 0)).toBe(-1);
    expect(moveSelection(5, -1, 0)).toBe(-1);
  });
});

describe('formatResultPath', () => {
  it('用斜杠连接祖先标题', () => {
    expect(
      formatResultPath({
        ...result('a', 'todo'),
        path: [
          { id: null, title: '根看板' },
          { id: 'p', title: '重构登录' },
        ],
      }),
    ).toBe('根看板 / 重构登录');
  });

  it('路径取不到时是空串，界面据此不画那一行', () => {
    expect(formatResultPath(result('a', 'todo'))).toBe('');
  });
});
