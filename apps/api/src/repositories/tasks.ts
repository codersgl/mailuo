import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { ROOT_BOARD_TITLE } from '../domain/board.js';
import { ORDERS_STEP } from '../domain/orders.js';

/** 任务的完整字段。数据库列名保持 snake_case，对外统一 camelCase（见 docs/decisions.md D4）。 */
export interface TaskRecord {
  id: string;
  parentId: string | null;
  columnId: string;
  title: string;
  description: string;
  /** 工期，单位天；0 表示未估工期。 */
  duration: number;
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
  duration: number;
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
  duration?: number;
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
  'id, parent_id, column_id, title, description, duration, orders, created_at, updated_at, archived_at';

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
    duration: row.duration,
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
      `SELECT id, parent_id, title, column_id
       FROM tasks
       WHERE (@includeArchived = 1 OR archived_at IS NULL)
       ORDER BY parent_id, orders`,
    )
    .all({ includeArchived: includeArchived ? 1 : 0 }) as Array<{
    id: string;
    parent_id: string | null;
    title: string;
    column_id: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    columnId: row.column_id,
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
 * 面包屑：第一项是根看板（id 为 null），随后是从根到 taskId 自身的每一层。
 * 任务不存在返回 undefined。父链理论上无环，仍加 visited 集合防御脏数据导致死循环。
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
      // 父行缺失同样只可能来自脏数据（外键开启时不可达）。返回 undefined 让路由回 404，
      // 不要把它当成根任务，否则前端会显示一条错误的面包屑。
      return undefined;
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
      `INSERT INTO tasks (id, parent_id, column_id, title, description, duration, orders, created_at, updated_at, archived_at)
       VALUES (@id, @parentId, @columnId, @title, '', 0, @orders, @createdAt, @updatedAt, NULL)`,
    ).run({
      id,
      parentId: input.parentId,
      columnId: input.columnId,
      title: input.title,
      orders: maxRow.max_orders + ORDERS_STEP,
      createdAt: now,
      updatedAt: now,
    });

    const created = findTask(db, id);
    if (!created) {
      throw new Error(`新建任务后读不到记录: ${id}`);
    }
    return created;
  });

  return insert.immediate();
}

/**
 * 改标题、描述、工期。只更新传入的字段，同时刷新 updated_at。
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
  if (patch.duration !== undefined) {
    assignments.push('duration = @duration');
    params.duration = patch.duration;
  }

  const update = db.transaction((): TaskRecord | undefined => {
    if (assignments.length === 0) return findTask(db, id);
    const result = db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')}, updated_at = @updatedAt WHERE id = @id`)
      .run(params);
    if (result.changes === 0) return undefined;
    return findTask(db, id);
  });

  return update();
}

/**
 * 一次 PATCH 的全部改动：字段更新与列内移动放在同一个事务里。
 * 任务不存在返回 undefined。移动参数的成对校验由路由层的 schema 负责。
 */
export function applyTaskUpdate(db: Db, id: string, patch: UpdateTaskInput): TaskRecord | undefined {
  const hasFieldUpdate =
    patch.title !== undefined || patch.description !== undefined || patch.duration !== undefined;
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
    return findTask(db, id);
  });

  return apply.immediate();
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
