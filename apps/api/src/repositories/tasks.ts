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

const TASK_COLUMNS =
  'id, parent_id, column_id, title, description, duration, orders, created_at, updated_at, archived_at';

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
 * 全部未归档任务的精简字段，供前端一次性建树。
 * 排序只为让返回稳定，树里不支持排序。
 */
export function listTreeTasks(db: Db): TreeTask[] {
  const rows = db
    .prepare(
      `SELECT id, parent_id, title, column_id
       FROM tasks
       WHERE archived_at IS NULL
       ORDER BY parent_id, orders`,
    )
    .all() as Array<{ id: string; parent_id: string | null; title: string; column_id: string }>;

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    columnId: row.column_id,
  }));
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
      throw new Error(`任务的父子关系成环: ${current.id}`);
    }
    visited.add(current.id);
    items.unshift({ id: current.id, title: current.title });
    current = current.parentId === null ? undefined : findTask(db, current.parentId);
  }
  items.unshift({ id: null, title: ROOT_BOARD_TITLE });
  return items;
}

/**
 * 新建任务，追加到目标列末尾。
 * orders 取同一父任务下该列当前的 MAX(orders) + ORDERS_STEP，取值和插入放在一个事务里。
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

  return insert();
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
