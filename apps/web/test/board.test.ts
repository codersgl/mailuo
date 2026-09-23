import { describe, expect, it } from 'vitest';
import { moveTaskInBoard, positionForDrop } from '../src/domain/board';
import type { Board, BoardColumn, BoardTask } from '../src/api/types';

/** 让每个 fixture 的 createdAt 严格递增，见 task() 里的说明。 */
let createdAtSequence = 0;

/**
 * 只给测试用到的字段赋值：重排看 id / columnId / archivedAt / orders，
 * 归档卡片与未归档卡片 orders 撞上时还要看 createdAt（对应后端的 rowid 顺序），所以逐个递增。
 */
function task(
  id: string,
  columnId: string,
  options: { archived?: boolean; orders?: number; createdAt?: string } = {},
): BoardTask {
  createdAtSequence += 1;
  return {
    id,
    parentId: null,
    columnId,
    title: `任务 ${id}`,
    description: '',
    durationMinutes: null,
    spentMinutes: 0,
    runningSince: null,
    orders: options.orders ?? 1000,
    // 用毫秒偏移保证严格递增：同值时排序会退化成不稳定比较。
    createdAt:
      options.createdAt ?? new Date(Date.UTC(2026, 8, 22, 0, 0, 0, createdAtSequence)).toISOString(),
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

  it('归档卡片不算进 position 的取值域：把 c 插到 b 之前，归档的 a 仍排在它前面', () => {
    // 列里渲染顺序 a（归档@1000）→ b → c。把 c 插到「b 之前」= 未归档列表 [b] 的下标 0。
    // 后端只重写位置真变了的任务：a 仍是 1000，c 被编到 1000、b 到 2000。
    // c 与 a 同为 1000，同值时按 created_at（= 后端的 rowid 顺序），a 更早，所以 a 在前。
    const before = board({
      todo: [task('a', 'todo', { archived: true, orders: 1000 }), task('b', 'todo', { orders: 2000 }), task('c', 'todo', { orders: 3000 })],
    });

    const after = moveTaskInBoard(before, { taskId: 'c', columnId: 'todo', position: 0 });

    expect(ids(after, 'todo')).toEqual(['a', 'c', 'b']);
  });

  it('归档卡片可能因为重编号被挤到别处，预览与后端一致（后端实测：B A X C）', () => {
    // 输入 B@1000 A@2000 X(归档)@3000 C@4000，把 C 拖到列尾（未归档下标 2）。
    // C 拿到 3000，与归档的 X 撞值，而 X 不参与重排 —— 于是 X 与 C 的相对次序由同值规则决定。
    // 这条与下一条是审阅里发现「预览顺序 ≠ 落库顺序」的那组用例（见 docs/decisions.md D42）。
    const before = board({
      todo: [
        task('B', 'todo', { orders: 1000 }),
        task('A', 'todo', { orders: 2000 }),
        task('X', 'todo', { orders: 3000, archived: true }),
        task('C', 'todo', { orders: 4000 }),
      ],
    });

    const after = moveTaskInBoard(before, { taskId: 'C', columnId: 'todo', position: 2 });

    expect(ids(after, 'todo')).toEqual(['B', 'A', 'X', 'C']);
  });

  it('位置没变的任务不被重新编号：归档卡片因此留在列尾（后端实测：B A C X）', () => {
    // 输入 B@1000 A@2000 C@3000 X(归档)@9000，把 C 拖到列尾 —— 它的新编号仍是 3000，
    // 后端与前端都不重写任何人，X 留在最后。若一律按新下标重写，A 会变 1000、C 变 2000，
    // X@9000 反而被挤到 C 前面，预览就与落库结果分叉了。
    const before = board({
      todo: [
        task('B', 'todo', { orders: 1000 }),
        task('A', 'todo', { orders: 2000 }),
        task('C', 'todo', { orders: 3000 }),
        task('X', 'todo', { orders: 9000, archived: true }),
      ],
    });

    const after = moveTaskInBoard(before, { taskId: 'C', columnId: 'todo', position: 2 });

    expect(ids(after, 'todo')).toEqual(['B', 'A', 'C', 'X']);
  });

  it('任务不在看板里时原样返回，不产生新对象', () => {
    const before = board({ todo: [task('a', 'todo')] });

    expect(moveTaskInBoard(before, { taskId: 'nope', columnId: 'todo', position: 0 })).toBe(before);
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
