import type { Board, BoardTask } from '../api/types';

/**
 * 同一 (parent_id, column_id) 内 orders 的编号间隔，必须与后端一致
 * （apps/api/src/domain/orders.ts）：前端乐观重排照后端的算法重新编号，两边才会算出同一个顺序。
 */
const ORDERS_STEP = 1000;

/**
 * 看板的本地重排。拖拽落定到服务端确认之间有几十毫秒，这段窗口里界面必须立刻反映用户的操作，
 * 否则卡片会先弹回原位再跳到新位置。重排逻辑只在这一处，组件不自己拼数组。
 *
 * 与后端 `moveTask`（apps/api/src/repositories/tasks.ts）的口径必须逐条对齐——它们不是
 * 「差不多」，而是同一套算法的两份实现：
 * - `position` 是目标列里 0 基的插入下标，按「先把任务移出再插入」计算，超出长度按末尾处理。
 * - 只重排**未归档**卡片，编号 1000、2000、……；归档卡片保留自己的 orders（见 D20）。
 * - 编号与「原 orders」相同的任务不写。这条最容易被漏掉：归档卡片的 orders 没被重写时，
 *   它可能落在重新编号后的未归档卡片**中间**，漏掉这条就会算出另一个顺序（见 reorderColumn）。
 *
 * 预览与落库顺序不一致的代价是肉眼可见的：松手后的静默重取会把卡片挪到别处，看起来像
 * 「拖了没反应」或「卡片自己跳了一下」。这个缺陷在审阅里被发现（见 docs/decisions.md D42）。
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

/**
 * 一次移动。`position` 的口径见文件头的说明：目标列未归档卡片里的 0 基插入下标，
 * 按「先把任务移出再插入」计算。
 */
export interface TaskMove {
  taskId: string;
  columnId: string;
  position: number;
}

/** 把一张卡片移到目标列的 `position` 处，返回新的看板。 */
export function moveTaskInBoard(board: Board, move: TaskMove): Board {
  const moving = findTask(board, move.taskId);
  if (moving === undefined) return board;

  const columns = board.columns.map((column) => {
    if (column.id !== move.columnId) {
      return { ...column, tasks: column.tasks.filter((task) => task.id !== move.taskId) };
    }
    return { ...column, tasks: reorderColumn(column.tasks, move, moving) };
  });

  return { ...board, columns };
}

/**
 * 重排一列：把被移动的卡片插到未归档序列的 `position` 处，重新编号，再按新 orders 排序。
 *
 * 两个细节都是照后端抄的，少一个就会与落库结果分叉：
 * - 归档卡片参与最后的排序但不参与编号，所以它们可能被挤到别的位置——这正是后端的输出。
 * - 新编号与原值相同的任务保持原样（后端 `moveTask` 里的 `previous.orders === orders` 早退）。
 *   例：未归档 [B@1000, A@2000, C@3000] 加归档 X@9000，把 C 留在列尾时谁都不该被重写，
 *   X 仍在最后；若一律按新下标重写，C 变 2000、A 变 1000……X 反而被挤到前面。
 */
function reorderColumn(tasks: BoardTask[], move: TaskMove, moving: BoardTask): BoardTask[] {
  const unarchived = tasks
    .filter((task) => task.id !== move.taskId && task.archivedAt === null)
    .sort((left, right) => left.orders - right.orders);
  const insertAt = Math.min(Math.max(move.position, 0), unarchived.length);
  const ordered = [
    ...unarchived.slice(0, insertAt),
    { ...moving, columnId: move.columnId },
    ...unarchived.slice(insertAt),
  ];

  const nextOrders = new Map<string, number>();
  ordered.forEach((task, index) => nextOrders.set(task.id, (index + 1) * ORDERS_STEP));

  const archived = tasks.filter((task) => task.id !== move.taskId && task.archivedAt !== null);
  return [...ordered, ...archived]
    .map((task) => {
      const orders = nextOrders.get(task.id);
      const columnId = task.id === move.taskId ? move.columnId : task.columnId;
      if (orders === undefined) return task;
      if (orders === task.orders && columnId === task.columnId) return task;
      return { ...task, orders, columnId };
    })
    .sort(compareOrders);
}

/**
 * 与后端同序：先按 orders；同值再按 created_at 升序。
 *
 * 同值不是理论情况：归档卡片保留原 orders，未归档重新编号是 1000、2000、……，两者会撞上
 * （例：把一张卡片拖到列尾，它拿到的 3000 可能与某张归档卡片相同）。后端那条 SQL 的
 * `ORDER BY t.column_id, t.orders` 没有次级键，同值时的次序由扫描顺序（= rowid 升序 = 插入顺序）
 * 决定，created_at 是前端能拿到的最接近的对应物。真出现两者都相同的数据时，次序由后端定，
 * 下一次重取会纠正——这种极端情况不值得再往后端加次级排序键。
 */
function compareOrders(left: BoardTask, right: BoardTask): number {
  if (left.orders !== right.orders) return left.orders - right.orders;
  return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
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
