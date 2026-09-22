import type { Db } from '../db/client.js';
import { DONE_COLUMN_ID } from '../domain/columns.js';

/** 看板里的一个任务卡片。字段名对前端统一用 camelCase，数据库列名保持 snake_case。 */
export interface BoardTask {
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
  /** 直接子任务中未归档的数量。 */
  childTotal: number;
  /** childTotal 里处于完成列的数量。 */
  childDone: number;
}

export interface BoardColumn {
  id: string;
  name: string;
  orders: number;
  tasks: BoardTask[];
}

export interface Board {
  /** null 表示根看板。 */
  parentId: string | null;
  columns: BoardColumn[];
}

/** 与 SQL 查询列一一对应的原始行。 */
interface BoardTaskRow {
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
  child_total: number;
  child_done: number;
}

/**
 * 读取某一层看板：三列 + 该层未归档任务 + 每个任务的直接子任务进度。
 *
 * 进度计数只统计直接子任务、单层不递归：分母是未归档子任务数，分子是其中完成列的数量。
 * 两个口径都在同一条查询里用 LEFT JOIN 算出，避免 N+1。
 */
export function readBoard(db: Db, parentId: string | null): Board {
  const conditions = ['t.archived_at IS NULL'];
  const params: Record<string, string> = { doneColumnId: DONE_COLUMN_ID };
  if (parentId === null) {
    conditions.push('t.parent_id IS NULL');
  } else {
    conditions.push('t.parent_id = @parentId');
    params.parentId = parentId;
  }

  const rows = db
    .prepare(
      `SELECT t.id, t.parent_id, t.column_id, t.title, t.description, t.duration, t.orders,
              t.created_at, t.updated_at, t.archived_at,
              COUNT(c.id) AS child_total,
              COALESCE(SUM(CASE WHEN c.column_id = @doneColumnId THEN 1 ELSE 0 END), 0) AS child_done
       FROM tasks t
       LEFT JOIN tasks c ON c.parent_id = t.id AND c.archived_at IS NULL
       WHERE ${conditions.join(' AND ')}
       GROUP BY t.id
       ORDER BY t.column_id, t.orders`,
    )
    .all(params) as BoardTaskRow[];

  const columnRows = db
    .prepare('SELECT id, name, orders FROM columns ORDER BY orders')
    .all() as Array<{ id: string; name: string; orders: number }>;

  const tasksByColumn = new Map<string, BoardTask[]>();
  for (const row of rows) {
    const bucket = tasksByColumn.get(row.column_id) ?? [];
    bucket.push(toBoardTask(row));
    tasksByColumn.set(row.column_id, bucket);
  }

  return {
    parentId,
    columns: columnRows.map((column) => ({
      id: column.id,
      name: column.name,
      orders: column.orders,
      tasks: tasksByColumn.get(column.id) ?? [],
    })),
  };
}

function toBoardTask(row: BoardTaskRow): BoardTask {
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
    childTotal: row.child_total,
    childDone: row.child_done,
  };
}
