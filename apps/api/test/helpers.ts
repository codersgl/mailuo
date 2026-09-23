import path from 'node:path';
import type { Db } from '../src/db/client.js';
import { openDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

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
