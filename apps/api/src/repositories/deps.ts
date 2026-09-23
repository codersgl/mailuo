import type { Db } from '../db/client.js';
import type { EdgeSchedule, ScheduleNodeInput, TaskSchedule } from '../domain/cpm.js';
import { computeSchedule } from '../domain/cpm.js';
import type { TaskRecord } from './tasks.js';
import { findTask } from './tasks.js';

/** 一条依赖边：predecessor 完成后 successor 才能开始。 */
export interface DependencyEdge {
  predecessorId: string;
  successorId: string;
}

/** 依赖图里的一个任务：任务本身要展示的字段 + 算出来的时间参数。 */
export interface ScheduleTask extends TaskSchedule {
  title: string;
  columnId: string;
  /** 工期分钟数，null 表示未估。CPM 按 0 计算，界面按 null 提示「未估」（见 docs/spec.md）。 */
  durationMinutes: number | null;
  /** 非空表示已归档（只有 includeArchived 打开时才可能出现在结果里）。 */
  archivedAt: string | null;
}

/** `GET /api/board[/:parentId]/cpm` 的响应。 */
export interface LayerSchedule {
  /** null 表示根看板。 */
  parentId: string | null;
  /** 该层的总工期（分钟）：所有任务最早完成时间的最大值。 */
  projectDuration: number;
  nodes: ScheduleTask[];
  edges: EdgeSchedule[];
}

interface ScheduleTaskRow {
  id: string;
  title: string;
  column_id: string;
  duration_minutes: number | null;
  archived_at: string | null;
}

/**
 * 该层任务的依赖图 + 关键路径。计算结果不落库，每次读取时重算
 * （个人规模下重算成本可忽略，依赖或工期一变缓存即失效，见 docs/spec.md）。
 *
 * `includeArchived` 沿用所有读接口的开关语义：关着时归档任务与连着它的边都不出现。
 * 已知取舍：归档一个被别人依赖的任务不会清理依赖记录，于是关着开关时那些边看不见；
 * 打开开关就能看到完整的图。要彻底解决得在归档时改依赖，属于产品决策，这一步不做。
 */
export function readLayerSchedule(
  db: Db,
  parentId: string | null,
  includeArchived = false,
): LayerSchedule {
  const rows = listLayerTaskRows(db, parentId, includeArchived);
  const edges = listLayerDeps(db, parentId, includeArchived);
  const inputs: ScheduleNodeInput[] = rows.map((row) => ({
    id: row.id,
    durationMinutes: row.duration_minutes,
  }));
  const schedule = computeSchedule(inputs, edges);
  const timingById = new Map(schedule.tasks.map((task) => [task.id, task]));

  return {
    parentId,
    projectDuration: schedule.projectDuration,
    nodes: rows.map((row) => {
      const timing = timingById.get(row.id);
      if (!timing) {
        throw new Error(`缺少任务的时间参数: ${row.id}`);
      }
      return {
        ...timing,
        title: row.title,
        columnId: row.column_id,
        durationMinutes: row.duration_minutes,
        archivedAt: row.archived_at,
      };
    }),
    edges: schedule.edges,
  };
}

/** 该层的任务行，按列序 + 列内 orders 排，方便前端按看板顺序排布节点。 */
function listLayerTaskRows(
  db: Db,
  parentId: string | null,
  includeArchived: boolean,
): ScheduleTaskRow[] {
  const conditions = [layerCondition(parentId, 't'), ...visibilityConditions(includeArchived, ['t'])];
  return db
    .prepare(
      `SELECT t.id, t.title, t.column_id, t.duration_minutes, t.archived_at
       FROM tasks t
       JOIN columns c ON c.id = t.column_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.orders, t.orders, t.id`,
    )
    .all(layerParams(parentId)) as ScheduleTaskRow[];
}

/**
 * 该层内部的依赖边。两端都必须落在这一层：同层校验保证正常数据如此，
 * 手工改库造出的跨层边在这里被过滤掉，而不是给前端一条端点不存在的边。
 */
export function listLayerDeps(
  db: Db,
  parentId: string | null,
  includeArchived = false,
): DependencyEdge[] {
  const conditions = [
    layerCondition(parentId, 'p'),
    layerCondition(parentId, 's'),
    ...visibilityConditions(includeArchived, ['p', 's']),
  ];
  const rows = db
    .prepare(
      `SELECT d.predecessor_id, d.successor_id
       FROM task_deps d
       JOIN tasks p ON p.id = d.predecessor_id
       JOIN tasks s ON s.id = d.successor_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY d.predecessor_id, d.successor_id`,
    )
    .all(layerParams(parentId)) as Array<{ predecessor_id: string; successor_id: string }>;

  return rows.map((row) => ({ predecessorId: row.predecessor_id, successorId: row.successor_id }));
}

/**
 * 某个任务的直接前置依赖 id，按 id 升序。
 * 依赖在库里是一个集合（主键是两端），不存在顺序，升序只是为了让写接口的响应稳定。
 */
export function listPredecessorIds(db: Db, taskId: string): string[] {
  const rows = db
    .prepare('SELECT predecessor_id FROM task_deps WHERE successor_id = ? ORDER BY predecessor_id')
    .all(taskId) as Array<{ predecessor_id: string }>;
  return rows.map((row) => row.predecessor_id);
}

/**
 * 整体替换任务的前置依赖（见 docs/spec.md 的 `PUT /api/tasks/:id/deps`）。
 * 任务不存在返回 undefined；成功返回改动后的任务记录。
 *
 * 依赖集合没变时一行都不写：重复提交同一份依赖不该刷新 updated_at，
 * 与归档的幂等空操作同一个口径（见 docs/decisions.md D24）。
 * 校验（存在性、同层、环）由路由层先做，这里只负责写。
 */
export function setTaskDeps(
  db: Db,
  taskId: string,
  predecessorIds: string[],
): TaskRecord | undefined {
  const next = [...new Set(predecessorIds)].sort();

  const apply = db.transaction((): TaskRecord | undefined => {
    if (!findTask(db, taskId)) return undefined;

    const current = listPredecessorIds(db, taskId);
    if (current.length !== next.length || current.some((id, index) => id !== next[index])) {
      db.prepare('DELETE FROM task_deps WHERE successor_id = ?').run(taskId);
      const insert = db.prepare(
        'INSERT INTO task_deps (predecessor_id, successor_id) VALUES (?, ?)',
      );
      for (const predecessorId of next) {
        insert.run(predecessorId, taskId);
      }
      // 依赖变了，这个任务的排期也变了；updated_at 是「最近改动」的唯一依据（搜索按它排序）。
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), taskId);
    }

    return findTask(db, taskId);
  });

  return apply.immediate();
}

/**
 * 找出「加进去就会成环」的那个前置任务，没有则返回 undefined。
 *
 * 原理：把 predecessor→successor 看作有向边，新增 `p → taskId` 会成环，当且仅当顺着
 * successor 方向从 taskId 已经能走到 p（也就是 p 直接或间接地依赖 taskId）。
 * 返回请求里的第一个命中者，让报错文案能指出是哪一个。
 *
 * 递归 CTE 用 UNION 而不是 UNION ALL：库里已经有环（手工改库）时递归也能终止。
 */
export function findDependencyCycle(
  db: Db,
  taskId: string,
  predecessorIds: string[],
): string | undefined {
  if (predecessorIds.length === 0) return undefined;

  const rows = db
    .prepare(
      `WITH RECURSIVE reach(id) AS (
         SELECT successor_id FROM task_deps WHERE predecessor_id = @taskId
         UNION
         SELECT d.successor_id FROM task_deps d JOIN reach r ON d.predecessor_id = r.id
       )
       SELECT id FROM reach`,
    )
    .all({ taskId }) as Array<{ id: string }>;
  const reachable = new Set(rows.map((row) => row.id));

  return predecessorIds.find((predecessorId) => reachable.has(predecessorId));
}

/** 层级条件：根看板是 `parent_id IS NULL`，其余按父任务过滤。 */
function layerCondition(parentId: string | null, alias: string): string {
  return parentId === null ? `${alias}.parent_id IS NULL` : `${alias}.parent_id = @parentId`;
}

/** 「显示已归档」关着时只看未归档任务。 */
function visibilityConditions(includeArchived: boolean, aliases: string[]): string[] {
  if (includeArchived) return [];
  return aliases.map((alias) => `${alias}.archived_at IS NULL`);
}

function layerParams(parentId: string | null): Record<string, string> {
  return parentId === null ? {} : { parentId };
}
