import { describe, expect, it } from 'vitest';
import {
  columnOf,
  columnPeers,
  moveTaskInBoard,
  positionForDrop,
} from '../src/domain/board';
import type { Board, BoardColumn, BoardTask } from '../src/api/types';

/** 只给测试用到的字段赋值：重排只看 id / columnId / archivedAt / orders。 */
function task(id: string, columnId: string, options: { archived?: boolean; orders?: number } = {}): BoardTask {
  return {
    id,
    parentId: null,
    columnId,
    title: `任务 ${id}`,
    description: '',
    durationMinutes: null,
    orders: options.orders ?? 1000,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    archivedAt: options.archived === true ? '2026-09-22T00:00:00.000Z' : null,
    childTotal: 0,
    childDone: 0,
  };
}

function board(columns: Record<string, BoardTask[]>): Board {
  const names: Record<string, string> = { todo: '待办', doing: '进行中', done: '完成' };
  return {
    parentId: null,
    columns: Object.entries(columns).map(([id, tasks], index): BoardColumn => ({
      id,
      name: names[id] ?? id,
      orders: (index + 1) * 1000,
      tasks,
    })),
  };
}

/** 断言某一列的卡片顺序，用例里只关心 id。 */
function ids(board: Board, columnId: string): string[] {
  return (board.columns.find((column) => column.id === columnId)?.tasks ?? []).map((t) => t.id);
}

describe('moveTaskInBoard', () => {
  it('同列内前移：把 c 插到 a 之前', () => {
    const before = board({ todo: [task('a', 'todo'), task('b', 'todo'), task('c', 'todo')] });

    const after = moveTaskInBoard(before, { taskId: 'c', columnId: 'todo', position: 0 });

    expect(ids(after, 'todo')).toEqual(['c', 'a', 'b']);
  });

  it('同列内后移：position 按「已移除自己」的列表算，与后端一致', () => {
    const before = board({ todo: [task('a', 'todo'), task('b', 'todo'), task('c', 'todo')] });

    // 把 a 移到 c 之后：移除 a 得 [b, c]，插入下标是 2。
    const after = moveTaskInBoard(before, { taskId: 'a', columnId: 'todo', position: 2 });

    expect(ids(after, 'todo')).toEqual(['b', 'c', 'a']);
  });

  it('跨列移动：落到目标列指定位置，源列少一张', () => {
    const before = board({ todo: [task('a', 'todo'), task('b', 'todo')], doing: [task('x', 'doing')] });

    const after = moveTaskInBoard(before, { taskId: 'a', columnId: 'doing', position: 0 });

    expect(ids(after, 'todo')).toEqual(['b']);
    expect(ids(after, 'doing')).toEqual(['a', 'x']);
  });

  it('被移动卡片的 columnId 跟着改，源列里不再出现它', () => {
    const before = board({ todo: [task('a', 'todo')], done: [] });

    const after = moveTaskInBoard(before, { taskId: 'a', columnId: 'done', position: 0 });

    expect(after.columns.find((column) => column.id === 'done')?.tasks[0]?.columnId).toBe('done');
    expect(ids(after, 'todo')).toEqual([]);
  });

  it('position 超出长度时落到列尾，不报错', () => {
    const before = board({ todo: [task('a', 'todo'), task('b', 'todo')], done: [] });

    const after = moveTaskInBoard(before, { taskId: 'a', columnId: 'done', position: 99 });

    expect(ids(after, 'done')).toEqual(['a']);
  });

  it('归档卡片不算进 position 的取值域，且留在原来的相对位置', () => {
    // 列里渲染顺序是 a（归档）→ b → c。把 c 插到「b 之前」是未归档列表 [b] 的下标 0，
    // 结果应当是 a（归档）→ c → b：归档卡片没有被拖到别处，也没有挡住插入。
    const before = board({
      todo: [task('a', 'todo', { archived: true }), task('b', 'todo'), task('c', 'todo')],
    });

    const after = moveTaskInBoard(before, { taskId: 'c', columnId: 'todo', position: 0 });

    expect(ids(after, 'todo')).toEqual(['a', 'c', 'b']);
  });

  it('任务不在看板里时原样返回，不产生新对象', () => {
    const before = board({ todo: [task('a', 'todo')] });

    expect(moveTaskInBoard(before, { taskId: 'nope', columnId: 'todo', position: 0 })).toBe(before);
  });
});

describe('columnPeers', () => {
  it('返回同列未归档卡片，且不含自己', () => {
    const current = board({
      todo: [task('a', 'todo'), task('b', 'todo', { archived: true }), task('c', 'todo')],
    });

    expect(columnPeers(current, 'c').map((t) => t.id)).toEqual(['a']);
  });
});

describe('positionForDrop', () => {
  const current = board({
    todo: [task('a', 'todo'), task('b', 'todo'), task('c', 'todo')],
  });

  it('锚点卡片在未归档兄弟里的下标就是 position', () => {
    expect(positionForDrop(current, 'a', { columnId: 'todo', beforeTaskId: 'c' })).toBe(1);
  });

  it('beforeTaskId 为 null 表示落在列尾', () => {
    expect(positionForDrop(current, 'a', { columnId: 'todo', beforeTaskId: null })).toBe(2);
  });

  it('锚点已经不在列表里（数据过期）时退回列尾', () => {
    expect(positionForDrop(current, 'a', { columnId: 'todo', beforeTaskId: 'gone' })).toBe(2);
  });

  it('锚点是一张归档卡片时，数它前面有几张未归档卡片', () => {
    const withArchived = board({
      todo: [task('a', 'todo', { archived: true }), task('b', 'todo'), task('c', 'todo')],
    });

    // 拖到归档卡片 a 之前（渲染顺序第一格），a 前面没有未归档卡片，所以是 0。
    expect(positionForDrop(withArchived, 'c', { columnId: 'todo', beforeTaskId: 'a' })).toBe(0);
  });
});

describe('columnOf', () => {
  it('返回任务所在的列；任务不在看板里返回 undefined', () => {
    const current = board({ todo: [task('a', 'todo')], done: [task('b', 'done')] });

    expect(columnOf(current, 'b')?.id).toBe('done');
    expect(columnOf(current, 'nope')).toBeUndefined();
  });
});
