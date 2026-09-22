import type { Db } from '../db/client.js';
import { DONE_COLUMN_ID } from '../domain/columns.js';
import { listColumns } from './columns.js';
import type { TaskRecord, TaskRow } from './tasks.js';
import { toTaskRecord } from './tasks.js';

/** 看板里的一个任务卡片：任务基础字段 + 直接子任务进度。 */
export interface BoardTask extends TaskRecord {
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

/** 在任务行基础上多两列进度计数。 */
interface BoardTaskRow extends TaskRow {
  child_total: number;
  child_done: number;
}

/**
 * 读取某一层看板：三列 + 该层任务 + 每个任务的直接子任务进度。
 *
 * `includeArchived`（默认 false）为 true 时把归档任务也放进列里，供前端「显示已归档」开关使用
 * （见 docs/spec.md 的「归档」与 docs/decisions.md D6）。
 *
 * 进度计数只统计直接子任务、单层不递归：分母是未归档子任务数，分子是其中完成列的数量。
 * 两个口径都在同一条查询里用 LEFT JOIN 算出，避免 N+1；计数口径与开关无关，归档子任务永远不入分母。
 */
export function readBoard(db: Db, parentId: string | null, includeArchived = false): Board {
  const columnRows = listColumns(db);

  const tasksByColumn = new Map<string, BoardTask[]>();
  for (const task of selectBoardTasks(db, parentId, null, includeArchived)) {
    const bucket = tasksByColumn.get(task.columnId) ?? [];
    bucket.push(task);
    tasksByColumn.set(task.columnId, bucket);
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

/**
 * 某一列的完整任务列表（含直接子任务计数），按 orders 升序。
 * 移动或改动任务后返回给前端整列替换，排序逻辑只存在于后端（见 docs/spec.md）。
 * `includeArchived` 由写接口从请求参数透传，保证「显示已归档」模式下整列替换不会丢卡片。
 */
export function readColumnTasks(
  db: Db,
  parentId: string | null,
  columnId: string,
  includeArchived = false,
): BoardTask[] {
  return selectBoardTasks(db, parentId, columnId, includeArchived);
}

/** 看板任务的统一查询：层级（parentId）、可选列过滤，都走同一条带进度计数的 SELECT。 */
function selectBoardTasks(
  db: Db,
  parentId: string | null,
  columnId: string | null,
  includeArchived: boolean,
): BoardTask[] {
  // 不写 `archived_at IS NULL` 就是规范里「显示已归档时去掉此条件」的分支。
  const conditions = includeArchived ? [] : ['t.archived_at IS NULL'];
  const params: Record<string, string> = { doneColumnId: DONE_COLUMN_ID };
  if (parentId === null) {
    conditions.push('t.parent_id IS NULL');
  } else {
    conditions.push('t.parent_id = @parentId');
    params.parentId = parentId;
  }
  if (columnId !== null) {
    conditions.push('t.column_id = @columnId');
    params.columnId = columnId;
  }

  const rows = db
    .prepare(
      `SELECT t.id, t.parent_id, t.column_id, t.title, t.description, t.duration_minutes, t.orders,
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

  return rows.map(toBoardTask);
}

function toBoardTask(row: BoardTaskRow): BoardTask {
  return {
    ...toTaskRecord(row),
    childTotal: row.child_total,
    childDone: row.child_done,
  };
}
