import type { Board, BoardColumn, BoardTask } from '../api/types';

/**
 * 看板的本地重排。拖拽结束到服务端确认之间有几十毫秒，这段窗口里界面必须立刻反映用户的操作，
 * 否则卡片会先弹回原位再跳到新位置。重排逻辑只在这一处，组件不自己拼数组。
 *
 * 与后端 `moveTask`（apps/api/src/repositories/tasks.ts）的口径一致：
 * - `position` 是目标列里的 0 基插入下标，按「先把任务移出再插入」计算，超出长度按末尾处理。
 * - 已归档任务不参与重排（后端保留它们的 orders，见 docs/decisions.md D20），
 *   所以这里让归档卡片留在原位、不计算它们的位置，其余卡片的下标才是 position 的取值域。
 */

/**
 * 界面上的落点：哪一列的哪张卡片之前。`beforeTaskId` 为 null 表示落在列尾。
 * 由 hooks/useCardDrag 的命中测试产出，比后端要的 position 更贴近用户看到的东西——
 * 中间那次换算由 `positionForDrop` 完成。
 */
export interface DropSlot {
  columnId: string;
  beforeTaskId: string | null;
}

/** 在某一列里按未归档卡片数落位。`position` 的取值域由 `moveTaskInBoard` 的文档说明。 */
export interface TaskMove {
  taskId: string;
  columnId: string;
  position: number;
}

/**
 * 把一张卡片移到目标列的 `position` 处，返回新的看板。
 *
 * 目标列与源列相同时，`position` 的口径是「移除这张卡片之后的列表里的插入下标」，
 * 与后端一致。例：`[a, b, c]` 里的 `a` 移到 `c` 之后，移除 a 得 `[b, c]`，插入下标是 2。
 */
export function moveTaskInBoard(board: Board, move: TaskMove): Board {
  const moving = findTask(board, move.taskId);
  if (moving === undefined) return board;

  const columns = board.columns.map((column) => {
    // 先从所有列里摘掉它：目标列就是源列时，这一步同时完成了「移除」。
    const tasks = column.tasks.filter((task) => task.id !== move.taskId);
    if (column.id !== move.columnId) return { ...column, tasks };
    return { ...column, tasks: insertAt(tasks, { ...moving, columnId: move.columnId }, move.position) };
  });

  return { ...board, columns };
}

/** 该任务同一列里的未归档卡片（不含自己），按当前显示顺序。 */
export function columnPeers(board: Board, taskId: string): BoardTask[] {
  for (const column of board.columns) {
    if (!column.tasks.some((task) => task.id === taskId)) continue;
    return column.tasks.filter((task) => task.id !== taskId && task.archivedAt === null);
  }
  return [];
}

/**
 * 把界面上看到的落点换算成后端要的 `position`：锚点之前有几张未归档卡片，就是几。
 *
 * 这一步不能省：列里可能混着归档卡片（「显示已归档」打开时），而它们不参与重排，
 * 于是「渲染顺序里的下标」和「未归档卡片里的下标」会不一样。算法是照渲染顺序数未归档卡片，
 * 而不是在未归档子集里找锚点——锚点本身也可能是一张归档卡片（拖到它上方时），
 * 那时子集里找不到它，直接退回列尾会让卡片莫名落到最后一格。
 */
export function positionForDrop(board: Board, taskId: string, slot: DropSlot): number {
  const column = board.columns.find((candidate) => candidate.id === slot.columnId);
  const rendered = column?.tasks ?? [];
  if (slot.beforeTaskId === null) {
    return rendered.filter((task) => task.id !== taskId && task.archivedAt === null).length;
  }

  let index = 0;
  for (const task of rendered) {
    if (task.id === slot.beforeTaskId) return index;
    if (task.id !== taskId && task.archivedAt === null) index += 1;
  }
  // 锚点不在这一列里说明数据已经过期（例如后台重取换掉了这一列），退回列尾而不是抛错。
  return rendered.filter((task) => task.id !== taskId && task.archivedAt === null).length;
}

/** 卡片当前所在列。找不到任务时返回 undefined。 */
export function columnOf(board: Board, taskId: string): BoardColumn | undefined {
  return board.columns.find((column) => column.tasks.some((task) => task.id === taskId));
}

/**
 * 落点 → 后端入参。换算必须在**按下时的看板**上做：乐观重排之后那张卡片已经在新位置，
 * 拿它去数卡片会得到另一个下标，两者相差的可能正是这一次拖动。
 */
export function dropToMove(
  board: Board,
  taskId: string,
  slot: DropSlot,
): { columnId: string; position: number } {
  return { columnId: slot.columnId, position: positionForDrop(board, taskId, slot) };
}

function findTask(board: Board, taskId: string): BoardTask | undefined {
  for (const column of board.columns) {
    const task = column.tasks.find((candidate) => candidate.id === taskId);
    if (task !== undefined) return task;
  }
  return undefined;
}

/**
 * 按未归档卡片计数插入。`position` 是未归档卡片里的下标；
 * 归档卡片留在它们原来的相对位置上，不因为一次拖动而改变次序。
 */
function insertAt(tasks: BoardTask[], task: BoardTask, position: number): BoardTask[] {
  if (task.archivedAt !== null) {
    // 归档卡片不参与重排：插回它原来的相对位置即可（源列 == 目标列时等于没动）。
    return [...tasks, task].sort((left, right) => left.orders - right.orders);
  }

  const result: BoardTask[] = [];
  let unarchived = 0;
  let inserted = false;
  for (const candidate of tasks) {
    if (!inserted && candidate.archivedAt === null && unarchived === position) {
      result.push(task);
      inserted = true;
    }
    if (candidate.archivedAt === null) unarchived += 1;
    result.push(candidate);
  }
  if (!inserted) result.push(task);
  return result;
}
