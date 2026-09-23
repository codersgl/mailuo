import path from 'node:path';
import type { Db } from '../src/db/client.js';
import { openDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import type { Board, BoardTask } from '../src/repositories/board.js';
import type { LayerSchedule } from '../src/repositories/deps.js';
import type { SearchOutcome } from '../src/repositories/search.js';
import type { TaskRecord, TreeTask } from '../src/repositories/tasks.js';

export const migrationsDir = path.join(import.meta.dirname, '..', 'migrations');

/** 建一个已完成迁移的内存库，测试之间互不影响。 */
export function createTestDb(): Db {
  const db = openDatabase(':memory:');
  runMigrations(db, migrationsDir);
  return db;
}

let sequence = 0;
const FIXED_TIME = '2024-01-01T00:00:00.000Z';

/** 直接写库造数据，让看板查询测试不依赖尚未实现的 POST /api/tasks。 */
export function insertTask(
  db: Db,
  options: {
    title: string;
    columnId: string;
    orders: number;
    parentId?: string | null;
    archived?: boolean;
    /** 工期，单位分钟；不传表示未估。 */
    durationMinutes?: number | null;
    /**
     * 已结算的累计用时（分钟），不传为 0。
     * 计时相关的用例直接按需要的状态造行（例如「已用 61 分钟」），不经过接口。
     */
    spentMinutes?: number;
    /**
     * 正在计时的那一段的开始时刻，不传为 null。
     * 注意这里**不**按 columnId 自动补：真实写入口会维持「进行中且未归档 ⟺ 正在计时」这条不变式，
     * 而造数据时常常需要故意造出违反它的行来验证行为，自动补反而挡路。
     */
    runningSince?: string | null;
    /** 描述，不传为空串。 */
    description?: string;
    /** 更新时间；搜索按它做次序，所以要让测试能造出不同的值。不传用统一的固定时间。 */
    updatedAt?: string;
  },
): string {
  sequence += 1;
  const id = `task-${sequence}`;
  db.prepare(
    `INSERT INTO tasks (id, parent_id, column_id, title, description, duration_minutes, spent_minutes, running_since, orders, created_at, updated_at, archived_at)
     VALUES (@id, @parentId, @columnId, @title, @description, @durationMinutes, @spentMinutes, @runningSince, @orders, @createdAt, @updatedAt, @archivedAt)`,
  ).run({
    id,
    parentId: options.parentId ?? null,
    columnId: options.columnId,
    title: options.title,
    description: options.description ?? '',
    orders: options.orders,
    durationMinutes: options.durationMinutes ?? null,
    spentMinutes: options.spentMinutes ?? 0,
    runningSince: options.runningSince ?? null,
    createdAt: FIXED_TIME,
    updatedAt: options.updatedAt ?? FIXED_TIME,
    archivedAt: options.archived ? FIXED_TIME : null,
  });
  return id;
}

/**
 * 读响应体并按调用方声明的形状返回。
 *
 * `Response.json()` 的类型是 `unknown`（JSON 本身没有形状信息），而用例要直接访问字段，
 * 所以在这唯一一处集中断言，而不是在每个调用点写 `as`。形状取自 `src` 的响应类型，
 * 于是「直接访问的字段被改名」会在 `tsc` 阶段红（见审计报告 D3）——这正是把 `test/**`
 * 纳入类型检查的意义。覆盖范围只到直接属性访问：`toMatchObject({ ... })` 那种整体比对
 * 在 vitest 里不做额外属性检查，字段改名仍然是运行期才红。
 */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** `GET /api/board[/:parentId]` 的响应。 */
export type BoardBody = Board;

/** `GET /api/tree` 的响应。 */
export interface TreeBody {
  tasks: TreeTask[];
}

/** `GET /api/search` 的响应。 */
export type SearchBody = SearchOutcome;

/** `GET /api/board[/:parentId]/cpm` 的响应。 */
export type CpmBody = LayerSchedule;

/** `POST /api/tasks` 的响应：裸任务，没有 columnTasks（见审计报告 B4）。 */
export type TaskBody = TaskRecord;

/** 三条 PATCH（`:id`、`:id/parent`、`:id/archive`）的统一响应：改动后的任务 + 它所在列的完整列表。 */
export interface TaskMutationBody {
  task: TaskRecord;
  columnTasks: BoardTask[];
}

/** `DELETE /api/tasks/:id` 的响应：原列剩下的任务。 */
export interface ColumnTasksBody {
  columnTasks: BoardTask[];
}

/** `PUT /api/tasks/:id/deps` 的响应。 */
export interface DepsBody {
  task: TaskRecord;
  predecessorIds: string[];
}

/** 统一错误响应（见 docs/spec.md「错误统一返回 { error: string }」）。 */
export interface ErrorBody {
  error: string;
}
