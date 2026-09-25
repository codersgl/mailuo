import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { ROOT_BOARD_TITLE } from '../domain/board.js';
import { settleClock, shouldRun } from '../domain/clock.js';
import { deriveColumns } from '../domain/derive.js';
import { ORDERS_STEP } from '../domain/orders.js';
import type { DurationNode } from '../domain/subtreeDuration.js';

/** 任务的完整字段。数据库列名保持 snake_case，对外统一 camelCase（见 docs/decisions.md D4）。 */
export interface TaskRecord {
  id: string;
  parentId: string | null;
  columnId: string;
  title: string;
  description: string;
  /** 工期，单位分钟；null 表示未估工期，0 表示瞬时任务。 */
  durationMinutes: number | null;
  /** 已结算的累计用时，单位分钟，只在「进行中」列里增长。 */
  spentMinutes: number;
  /** 当前这一段的开始时刻；非空表示正在计时（不变式见 domain/clock.ts）。 */
  runningSince: string | null;
  orders: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** 与 SELECT 列表一一对应的原始行。其他仓储（如 board）会在它之上扩展字段。 */
export interface TaskRow {
  id: string;
  parent_id: string | null;
  column_id: string;
  title: string;
  description: string;
  duration_minutes: number | null;
  spent_minutes: number;
  running_since: string | null;
  orders: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** 供前端建树的精简字段（见 docs/spec.md 的 GET /api/tree）。 */
export interface TreeTask {
  id: string;
  parentId: string | null;
  title: string;
  columnId: string;
  /** 非空表示已归档。前端用它把归档节点画成另一种样式，而不是靠「是否在列表里」推断。 */
  archivedAt: string | null;
  durationMinutes: number | null;
  spentMinutes: number;
  runningSince: string | null;
}

/** 面包屑的一项。id 为 null 表示根看板。 */
export interface BreadcrumbItem {
  id: string | null;
  title: string;
}

export interface CreateTaskInput {
  parentId: string | null;
  columnId: string;
  title: string;
}

export interface UpdateTaskFieldsInput {
  title?: string;
  description?: string;
  /** 传 null 表示把工期改回未估（见 docs/decisions.md D32）。 */
  durationMinutes?: number | null;
}

/** 一次 PATCH 的完整入参：字段更新与列内移动可以同时出现。 */
export interface UpdateTaskInput extends UpdateTaskFieldsInput {
  columnId?: string;
  /** 目标列中的插入下标，从 0 开始。 */
  position?: number;
}

export interface MoveTaskInput {
  columnId: string;
  /** 目标列中的插入下标，从 0 开始；超出长度时按末尾处理。 */
  position: number;
}

export interface ChangeTaskParentInput {
  parentId: string | null;
  columnId: string;
}

const TASK_COLUMNS =
  'id, parent_id, column_id, title, description, duration_minutes, spent_minutes, running_since, orders, created_at, updated_at, archived_at';

/**
 * 递归求子树的 CTE。用 UNION（不是 UNION ALL）去重：父子关系成环的脏数据下递归也能终止。
 * 调用时传入 `@id` 作为子树的根。
 */
const SUBTREE_IDS_CTE = `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM tasks WHERE id = @id
       UNION
       SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
     )`;

/**
 * 任务及其全部后代的 id，含任务自己。
 * 一条 SQL 取完再交给调用方按 id 操作，而不是在 DELETE/UPDATE 里内联这段 CTE：
 * 内联时 CTE 与写操作作用于同一批行，先物化还是边写边算依赖 SQLite 的实现细节，
 * 先读后写不受影响。个人规模下这棵树只有几十个节点。
 */
function listSubtreeIds(db: Db, id: string): string[] {
  const rows = db.prepare(`${SUBTREE_IDS_CTE} SELECT id FROM subtree`).all({ id }) as Array<{
    id: string;
  }>;
  return rows.map((row) => row.id);
}

export function toTaskRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    columnId: row.column_id,
    title: row.title,
    description: row.description,
    durationMinutes: row.duration_minutes,
    spentMinutes: row.spent_minutes,
    runningSince: row.running_since,
    orders: row.orders,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

/** 按 id 查任务，不存在返回 undefined。已归档任务同样能查到，由调用方决定怎么处理。 */
export function findTask(db: Db, id: string): TaskRecord | undefined {
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  return row ? toTaskRecord(row) : undefined;
}

/**
 * 全部任务的精简字段，供前端一次性建树。
 * includeArchived 为 false 时只返回未归档任务（默认）；规范里「显示已归档」是前端开关，
 * 状态不落库，所以这里只按参数切换查询条件。
 * 排序只为让返回稳定，树里不支持排序。
 */
export function listTreeTasks(db: Db, includeArchived = false): TreeTask[] {
  const rows = db
    .prepare(
      `SELECT id, parent_id, title, column_id, archived_at,
              duration_minutes, spent_minutes, running_since
       FROM tasks
       WHERE (@includeArchived = 1 OR archived_at IS NULL)
       ORDER BY parent_id, orders`,
    )
    .all({ includeArchived: includeArchived ? 1 : 0 }) as Array<{
    id: string;
    parent_id: string | null;
    title: string;
    column_id: string;
    archived_at: string | null;
    duration_minutes: number | null;
    spent_minutes: number;
    running_since: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    columnId: row.column_id,
    archivedAt: row.archived_at,
    durationMinutes: row.duration_minutes,
    spentMinutes: row.spent_minutes,
    runningSince: row.running_since,
  }));
}

/** 任务的父子关系成环（只可能来自手工改库的脏数据）。路由层会把它当成 500 记日志。 */
export class TaskCycleError extends Error {
  constructor(taskId: string) {
    super(`任务的父子关系成环: ${taskId}`);
    this.name = 'TaskCycleError';
  }
}

/**
 * 任务的父行缺失（`parent_id` 指向一条不存在的任务），只可能来自手工改库的脏数据。
 *
 * 为什么不沿用「返回 undefined」：那会让 undefined 同时表示「这条任务不存在」和「父链断了」，
 * 同一份脏数据在三个消费者那里落到三种结局——面包屑路由回 404、搜索退化成空路径、
 * 仓储契约被重载。现在它与成环一样抛错，由调用方按场景决定收场（见审计报告 D4）。
 */
export class TaskParentMissingError extends Error {
  constructor(parentId: string) {
    super(`任务的父行缺失: ${parentId}`);
    this.name = 'TaskParentMissingError';
  }
}

/**
 * 面包屑：第一项是根看板（id 为 null），随后是从根到 taskId 自身的每一层。
 * 任务不存在返回 undefined；父链走不通（成环、父行缺失）抛错——单条任务的读当 500 记日志，
 * 批量搜索退化成空路径。父链理论上无环，仍加 visited 集合防御脏数据导致死循环。
 */
export function readBreadcrumb(db: Db, taskId: string): BreadcrumbItem[] | undefined {
  let current = findTask(db, taskId);
  if (!current) return undefined;

  const items: BreadcrumbItem[] = [];
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) {
      throw new TaskCycleError(current.id);
    }
    visited.add(current.id);
    items.unshift({ id: current.id, title: current.title });

    if (current.parentId === null) break;
    const parent = findTask(db, current.parentId);
    if (!parent) {
      // 外键开启时不可达；一旦出现，绝不能当成根任务，否则前端会显示一条错误的面包屑。
      throw new TaskParentMissingError(current.parentId);
    }
    current = parent;
  }
  items.unshift({ id: null, title: ROOT_BOARD_TITLE });
  return items;
}

/**
 * 新建任务，追加到目标列末尾。
 * orders 取同一父任务下该列当前的 MAX(orders) + ORDERS_STEP，取值和插入放在一个事务里。
 *
 * 两点刻意的取舍：
 * - MAX 不排除已归档任务。归档任务虽然不显示，将来取消归档时应该回到原来的位置；
 *   若把它们排除在外，新任务会插到它们前面，取消归档后顺序就乱了。
 * - 事务用 immediate：第一条语句是读 MAX、第二条才写，DEFERRED 事务会先拿读锁再升级，
 *   另一个进程（例如 dev watch 重启时短暂重叠）在中途写入就会抛 SQLITE_BUSY_SNAPSHOT。
 */
export function createTask(db: Db, input: CreateTaskInput): TaskRecord {
  const now = new Date().toISOString();
  const id = randomUUID();
  const parentCondition = input.parentId === null ? 'parent_id IS NULL' : 'parent_id = @parentId';
  const params =
    input.parentId === null
      ? { columnId: input.columnId }
      : { columnId: input.columnId, parentId: input.parentId };

  const insert = db.transaction((): TaskRecord => {
    const maxRow = db
      .prepare(
        `SELECT COALESCE(MAX(orders), 0) AS max_orders
         FROM tasks
         WHERE column_id = @columnId AND ${parentCondition}`,
      )
      .get(params) as { max_orders: number };

    db.prepare(
      `INSERT INTO tasks (id, parent_id, column_id, title, description, duration_minutes, spent_minutes, running_since, orders, created_at, updated_at, archived_at)
       VALUES (@id, @parentId, @columnId, @title, '', NULL, 0, @runningSince, @orders, @createdAt, @updatedAt, NULL)`,
    ).run({
      id,
      parentId: input.parentId,
      columnId: input.columnId,
      title: input.title,
      // 直接建在「进行中」列的任务从建立那一刻起计时，与拖进去同义。
      // 新任务还没有子任务，一定是叶子，所以 isLeaf 传 true。
      runningSince: shouldRun(input.columnId, null, true) ? now : null,
      orders: maxRow.max_orders + ORDERS_STEP,
      createdAt: now,
      updatedAt: now,
    });

    // 新建的子任务会把父任务从「叶子」变成「有子任务」：父任务的列要重新推导，计时也要停掉。
    reconcileDerivedStatus(db, now);

    const created = findTask(db, id);
    if (!created) {
      throw new Error(`新建任务后读不到记录: ${id}`);
    }
    return created;
  });

  return insert.immediate();
}

/**
 * 改标题、描述、工期（分钟）。只更新传入的字段，同时刷新 updated_at。
 * 任务不存在返回 undefined。路由层已保证至少传一个字段，这里的空 patch 分支只是防御。
 */
export function updateTaskFields(
  db: Db,
  id: string,
  patch: UpdateTaskFieldsInput,
): TaskRecord | undefined {
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) {
    assignments.push('title = @title');
    params.title = patch.title;
  }
  if (patch.description !== undefined) {
    assignments.push('description = @description');
    params.description = patch.description;
  }
  if (patch.durationMinutes !== undefined) {
    assignments.push('duration_minutes = @durationMinutes');
    params.durationMinutes = patch.durationMinutes;
  }

  const update = db.transaction((): TaskRecord | undefined => {
    if (assignments.length === 0) return findTask(db, id);
    const result = db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')}, updated_at = @updatedAt WHERE id = @id`)
      .run(params);
    if (result.changes === 0) return undefined;
    return findTask(db, id);
  });

  // 与其余写入口一致用 immediate：先读后写的 DEFERRED 事务会先拿读锁再升级，另一个进程
  // （例如 dev watch 重启时短暂重叠）中途写入就会抛 SQLITE_BUSY_SNAPSHOT。它现在被
  // applyTaskUpdate 的 immediate 事务包着（嵌套成 SAVEPOINT）才没暴露，但它是导出的，
  // 直接调用就会拿到 DEFERRED（见审计报告 D5）。
  return update.immediate();
}

/**
 * 一次 PATCH 的全部改动：字段更新与列内移动放在同一个事务里。
 * 任务不存在返回 undefined。移动参数的成对校验由路由层的 schema 负责。
 */
export function applyTaskUpdate(db: Db, id: string, patch: UpdateTaskInput): TaskRecord | undefined {
  const hasFieldUpdate =
    patch.title !== undefined ||
    patch.description !== undefined ||
    patch.durationMinutes !== undefined;
  const targetColumnId = patch.columnId;
  const targetPosition = patch.position;

  const apply = db.transaction((): TaskRecord | undefined => {
    if (!findTask(db, id)) return undefined;
    if (hasFieldUpdate) {
      updateTaskFields(db, id, patch);
    }
    if (targetColumnId !== undefined && targetPosition !== undefined) {
      moveTask(db, id, { columnId: targetColumnId, position: targetPosition });
    }
    // 移动会改到列，列是计时与父任务推导的输入，所以最后对一次账。
    reconcileDerivedStatus(db, new Date().toISOString());
    return findTask(db, id);
  });

  return apply.immediate();
}

/**
 * 让一个任务的计时跟上它「接下来」的状态，需要时写库。
 *
 * `next` 传的是**将要生效**的状态，所以调用方可以把「归档」表达成传一个非空的 archivedAt。
 * 只在时钟真的变了才发 UPDATE：这两列是派生状态、不是用户编辑，因此不动 updated_at
 * （与 moveTask 里「位置和列都没变就不写」同一个理由，见 D20 的注释）。
 * 参数只用到 id 与两个时钟字段，所以归档路径可以直接把查询结果传进来，不必先读整行。
 */
function settleTaskClock(
  db: Db,
  task: Pick<TaskRecord, 'id' | 'spentMinutes' | 'runningSince'>,
  next: { columnId: string; archivedAt: string | null; isLeaf: boolean },
  now: string,
): void {
  const current = { spentMinutes: task.spentMinutes, runningSince: task.runningSince };
  const settled = settleClock(current, shouldRun(next.columnId, next.archivedAt, next.isLeaf), now);
  if (settled === current) return;

  db.prepare(
    'UPDATE tasks SET spent_minutes = @spentMinutes, running_since = @runningSince WHERE id = @id',
  ).run({ id: task.id, spentMinutes: settled.spentMinutes, runningSince: settled.runningSince });
}

/**
 * 让一批任务停表（只用在归档路径）。
 *
 * 已归档的行不在 reconcileDerivedStatus 的扫描范围里——整棵归档子树都不显示，列与计时都留着
 * 原样，取消归档时才有依据——所以归档后要在这里把它们的表停掉，不能指望对账。
 * 一条 SELECT 取回整批，而不是逐个 findTask；分钟换算仍然只走 domain/clock.ts 那一份实现。
 */
function stopSubtreeClocks(db: Db, ids: string[], now: string): void {
  if (ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, spent_minutes, running_since FROM tasks WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{ id: string; spent_minutes: number; running_since: string | null }>;

  const update = db.prepare(
    'UPDATE tasks SET spent_minutes = @spentMinutes, running_since = @runningSince WHERE id = @id',
  );
  for (const row of rows) {
    const current = { spentMinutes: row.spent_minutes, runningSince: row.running_since };
    const settled = settleClock(current, false, now);
    if (settled === current) continue;
    update.run({
      id: row.id,
      spentMinutes: settled.spentMinutes,
      runningSince: settled.runningSince,
    });
  }
}

/** reconcileDerivedStatus 扫描出来的一行。 */
interface ReconcileRow {
  id: string;
  parent_id: string | null;
  column_id: string;
  spent_minutes: number;
  running_since: string | null;
}

/**
 * 把「列」与「计时」对齐到子任务的实际状态（规则见 domain/derive.ts 与 docs/spec.md 的「状态语义」）。
 *
 * 每个会改到父子关系、列或归档状态的写入口，都在自己的事务里、写完之后调一次。刻意做成
 * **全表重算**而不是逐个入口推算「这次影响了哪些祖先」：个人规模下全表扫描的成本可以忽略，
 * 而那种推演只要漏一处，看板上就会出现一个与子任务矛盾的父任务——最常漏的正是归档，
 * 把一个子任务收起来会让父任务从「有子任务」变回叶子。状态本来就一致时它一个字节都不写，
 * 所以重复调用是幂等的，服务启动时也拿它给老库兜一次底（见 apps/api/src/index.ts）。
 *
 * 已归档的任务整棵不参与：它们不显示，列与计时都留着原样。
 */
export function reconcileDerivedStatus(db: Db, now: string): void {
  const rows = db
    .prepare(
      `SELECT id, parent_id, column_id, spent_minutes, running_since
       FROM tasks WHERE archived_at IS NULL`,
    )
    .all() as ReconcileRow[];

  const derived = deriveColumns(
    rows.map((row) => ({ id: row.id, parentId: row.parent_id, columnId: row.column_id })),
  );

  // 未归档子任务数量：0 表示叶子。推导与计时（叶子才走表）都要用它。
  const childCount = new Map<string, number>();
  for (const row of rows) {
    if (row.parent_id === null) continue;
    childCount.set(row.parent_id, (childCount.get(row.parent_id) ?? 0) + 1);
  }

  // 同一批里多个任务被推导进同一个 (父任务, 列) 时，orders 要依次往后排。
  const nextOrders = readMaxOrders(db);
  const move = db.prepare(
    'UPDATE tasks SET column_id = @columnId, orders = @orders, updated_at = @updatedAt WHERE id = @id',
  );

  for (const row of rows) {
    const columnId = derived.get(row.id) ?? row.column_id;
    const isLeaf = (childCount.get(row.id) ?? 0) === 0;

    if (columnId !== row.column_id) {
      const key = ordersKey(row.parent_id, columnId);
      const orders = (nextOrders.get(key) ?? 0) + ORDERS_STEP;
      nextOrders.set(key, orders);
      move.run({ id: row.id, columnId, orders, updatedAt: now });
    }

    settleTaskClock(
      db,
      { id: row.id, spentMinutes: row.spent_minutes, runningSince: row.running_since },
      // 未归档行（扫描条件已保证）：archivedAt 固定传 null。
      { columnId, archivedAt: null, isLeaf },
      now,
    );
  }
}

/**
 * 每个 `(parent_id, column_id)` 里现有的最大 orders。
 *
 * 统计**不排除已归档行**，与 createTask 的 MAX 同一个理由：归档行保留着自己的 orders，
 * 被推导过来的任务不该插到它前面，否则取消归档时顺序就乱了。
 */
function readMaxOrders(db: Db): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT parent_id, column_id, MAX(orders) AS max_orders
       FROM tasks GROUP BY parent_id, column_id`,
    )
    .all() as Array<{ parent_id: string | null; column_id: string; max_orders: number }>;

  const maxOrders = new Map<string, number>();
  for (const row of rows) maxOrders.set(ordersKey(row.parent_id, row.column_id), row.max_orders);
  return maxOrders;
}

/** `(parent_id, column_id)` 的映射键。根层用空串代替 NULL——id 是 UUID，不会与它撞。 */
function ordersKey(parentId: string | null, columnId: string): string {
  return `${parentId ?? ''}\u0000${columnId}`;
}

/**
 * 未归档的直接子任务数量。0 表示这是叶子——只有叶子能被手动拖动（见 domain/derive.ts）。
 * 路由层用它决定要不要拒绝一次手动移动，判定口径与看板卡片的 childTotal 相同。
 */
export function countActiveChildren(db: Db, id: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM tasks WHERE parent_id = ? AND archived_at IS NULL')
    .get(id) as { count: number };
  return row.count;
}

/**
 * 全库未归档任务的 id / 父子 / 工期，喂给 `domain/subtreeDuration.ts` 算父任务的工期汇总。
 *
 * 为什么是整表：父任务的叶子在更深的层里，任何「只看这一层」的查询都看不到它们。个人规模
 * （几百个任务）下这条 SELECT 的成本可以忽略——与 reconcileDerivedStatus 每次写都全表重算
 * 同一个取舍。归档任务不进来：它们整支不参与汇总（见 docs/decisions.md D77/D78）。
 */
export function listActiveDurationNodes(db: Db): DurationNode[] {
  const rows = db
    .prepare('SELECT id, parent_id, duration_minutes FROM tasks WHERE archived_at IS NULL')
    .all() as Array<{ id: string; parent_id: string | null; duration_minutes: number | null }>;

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    durationMinutes: row.duration_minutes,
  }));
}

/**
 * 把任务移动到目标列的指定位置，并重写该列（同一父任务下）未归档任务的 orders。
 *
 * position 是目标列里的插入下标（0 开始，schema 已保证非负），按「先把任务移出、再插入」计算，
 * 超出长度按末尾处理。已归档任务不参与重排，保留原 orders（见 docs/decisions.md D20）。
 */
function moveTask(db: Db, id: string, input: MoveTaskInput): void {
  const task = findTask(db, id);
  if (!task) return;

  const siblings = db
    .prepare(
      `SELECT id, column_id, orders FROM tasks
       WHERE column_id = @columnId AND archived_at IS NULL AND id <> @id
         AND ${task.parentId === null ? 'parent_id IS NULL' : 'parent_id = @parentId'}
       ORDER BY orders`,
    )
    .all(
      task.parentId === null
        ? { columnId: input.columnId, id }
        : { columnId: input.columnId, id, parentId: task.parentId },
    ) as Array<{ id: string; column_id: string; orders: number }>;

  const insertAt = Math.min(input.position, siblings.length);
  const orderedIds = [
    ...siblings.slice(0, insertAt).map((row) => row.id),
    id,
    ...siblings.slice(insertAt).map((row) => row.id),
  ];

  const before = new Map<string, { columnId: string; orders: number }>();
  for (const row of siblings) {
    before.set(row.id, { columnId: row.column_id, orders: row.orders });
  }
  before.set(id, { columnId: task.columnId, orders: task.orders });

  const update = db.prepare(
    'UPDATE tasks SET column_id = @columnId, orders = @orders, updated_at = @updatedAt WHERE id = @id',
  );
  const now = new Date().toISOString();
  orderedIds.forEach((taskId, index) => {
    const orders = (index + 1) * ORDERS_STEP;
    const previous = before.get(taskId);
    // 位置和列都没变就不写。否则「拖动后放回原位」会把整列的 updated_at 全部刷新，
    // 将来做「最近变更」时数据就废了。
    if (previous && previous.orders === orders && previous.columnId === input.columnId) return;
    update.run({ id: taskId, columnId: input.columnId, orders, updatedAt: now });
  });

  // 计时不在这里结算：调用方（applyTaskUpdate）随后会跑一次 reconcileDerivedStatus，
  // 它按「叶子且未归档且在进行中」的统一判据重算全表，比在这里单独算被移动的这一个更靠得住
  // （拖动会同时改变它的父任务是不是叶子，两个任务的计时都可能变）。
}

/**
 * 改父级：任务挂到新父任务下，追加到目标列末尾（orders 取新同级该列的 MAX + ORDERS_STEP）。
 * 任务自身的子树跟着走，不需要额外处理。任务不存在返回 undefined。
 * 环检测由路由层先用 isSelfOrDescendant 做，这里只负责写入。
 */
export function changeTaskParent(
  db: Db,
  id: string,
  input: ChangeTaskParentInput,
): TaskRecord | undefined {
  const now = new Date().toISOString();
  const parentCondition = input.parentId === null ? 'parent_id IS NULL' : 'parent_id = @parentId';
  const params =
    input.parentId === null
      ? { columnId: input.columnId, id }
      : { columnId: input.columnId, id, parentId: input.parentId };

  const apply = db.transaction((): TaskRecord | undefined => {
    const task = findTask(db, id);
    if (!task) return undefined;

    const maxRow = db
      .prepare(
        `SELECT COALESCE(MAX(orders), 0) AS max_orders
         FROM tasks
         WHERE column_id = @columnId AND id <> @id AND ${parentCondition}`,
      )
      .get(params) as { max_orders: number };

    db.prepare(
      `UPDATE tasks
       SET parent_id = @parentId, column_id = @columnId, orders = @orders, updated_at = @updatedAt
       WHERE id = @id`,
    ).run({
      id,
      parentId: input.parentId,
      columnId: input.columnId,
      orders: maxRow.max_orders + ORDERS_STEP,
      updatedAt: now,
    });

    // 改父级同时可能换列，还会改变新旧父任务的叶子状态，两边的列与计时都要跟着走。
    // 统一交给对账：它按「叶子且未归档且在进行中」重算全表，最后重新读一次返回结算后的数据。
    reconcileDerivedStatus(db, now);
    return findTask(db, id);
  });

  return apply.immediate();
}

/**
 * 归档或取消归档整棵子树（见 docs/spec.md 的「归档」与 docs/decisions.md D24）。
 * 任务不存在返回 undefined，成功返回改动后的任务本身。
 *
 * - 归档：任务及其全部后代置 `archived_at`。已经归档的行保持原时间戳不动
 *   （它们是从别的入口先归档的），因此重复归档是幂等的，也不会白刷 `updated_at`。
 * - 取消归档：恢复整棵子树，并沿着 `parent_id` 向上把仍处于归档状态的祖先一并恢复，
 *   否则任务会挂在一个不显示的父节点下变成孤儿。
 *
 * 两条 UPDATE 都用「先取 id 再写」，理由同 listSubtreeIds。
 */
export function setTaskArchived(db: Db, id: string, archived: boolean): TaskRecord | undefined {
  const now = new Date().toISOString();

  const apply = db.transaction((): TaskRecord | undefined => {
    if (!findTask(db, id)) return undefined;

    if (archived) {
      const ids = listSubtreeIds(db, id);
      const placeholders = ids.map(() => '?').join(', ');
      // 只改未归档的行：已归档的后代保留原归档时间。
      db.prepare(
        `UPDATE tasks SET archived_at = ?, updated_at = ?
         WHERE archived_at IS NULL AND id IN (${placeholders})`,
      ).run(now, now, ...ids);
      // 归档之后整棵子树都不该再计时。这些行随即落到对账的扫描范围之外（它只看未归档行），
      // 所以这里必须显式停表。
      stopSubtreeClocks(db, ids, now);
    } else {
      // 祖先链：从任务的 parent_id 起逐层向上，遇到 NULL 停止。
      const ancestors = db
        .prepare(
          `WITH RECURSIVE ancestors(id) AS (
             SELECT parent_id FROM tasks WHERE id = @id AND parent_id IS NOT NULL
             UNION
             SELECT t.parent_id FROM tasks t JOIN ancestors a ON t.id = a.id
              WHERE t.parent_id IS NOT NULL
           )
           SELECT id FROM ancestors`,
        )
        .all({ id }) as Array<{ id: string }>;

      const ids = [...new Set([...listSubtreeIds(db, id), ...ancestors.map((row) => row.id)])];
      const placeholders = ids.map(() => '?').join(', ');
      // 只改已归档的行：祖先里本来就没归档的那几层不该被刷新 updated_at。
      db.prepare(
        `UPDATE tasks SET archived_at = NULL, updated_at = ?
         WHERE archived_at IS NOT NULL AND id IN (${placeholders})`,
      ).run(now, ...ids);
    }

    // 两个方向都要对账：归档会把某个父任务变回叶子，取消归档会给它带回子任务，
    // 两种情况下列与计时都变；取消归档还负责让「进行中」的叶子重新开始计时
    // （它被归档时停了表，恢复后 running_since 是空的，正是不变式要求补上的那一半）。
    reconcileDerivedStatus(db, now);

    return findTask(db, id);
  });

  return apply.immediate();
}

/**
 * 删除任务及其整棵子树，并清掉这些任务作为任意一端的依赖记录。
 * 任务不存在返回 undefined；成功返回被删掉的任务记录（调用方用它定位原来的列，好返回整列）。
 *
 * 级联放在应用层事务里，而不是给 `tasks.parent_id` 加 `ON DELETE CASCADE`（见 docs/decisions.md D7、D25）：
 * `task_deps` 的两端也要一起清，还要区分「只剩一端」的记录，写在这里比拆成两条迁移直白。
 *
 * 依赖行必须在任务行之前删：外键已开启，任务没了再删依赖会先撞上约束。
 * 任务行则可以用一条 `DELETE ... IN (...)` 连父子一起删——SQLite 的外键是立即约束，
 * 但检查发生在语句结束时，同一语句里删掉父子两端不构成中间态。行为由测试固定。
 */
export function deleteTaskSubtree(db: Db, id: string): TaskRecord | undefined {
  const remove = db.transaction((): TaskRecord | undefined => {
    const task = findTask(db, id);
    if (!task) return undefined;

    // 任务存在时子树至少含它自己，所以 ids 非空，`IN ()` 这种非法 SQL 不会出现。
    const ids = listSubtreeIds(db, id);
    const placeholders = ids.map(() => '?').join(', ');

    db.prepare(
      `DELETE FROM task_deps
       WHERE predecessor_id IN (${placeholders}) OR successor_id IN (${placeholders})`,
    ).run(...ids, ...ids);
    db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids);

    // 删掉最后一个子任务会把父任务变回叶子（计时该重新开始），父任务的列也可能随之改变。
    reconcileDerivedStatus(db, new Date().toISOString());

    return task;
  });

  return remove.immediate();
}

/**
 * candidateId 是否就是 taskId 本身、或位于它的子树中。用于阻止把任务挂到自己的后代下。
 * 直接复用子树查询：成环终止的性质已经在 listSubtreeIds 的 CTE 里保证，不再写第二份递归 SQL。
 */
export function isSelfOrDescendant(db: Db, taskId: string, candidateId: string): boolean {
  return listSubtreeIds(db, taskId).includes(candidateId);
}
