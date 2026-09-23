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
    /** 描述，不传为空串。 */
    description?: string;
    /** 更新时间；搜索按它做次序，所以要让测试能造出不同的值。不传用统一的固定时间。 */
    updatedAt?: string;
  },
): string {
  sequence += 1;
  const id = `task-${sequence}`;
  db.prepare(
    `INSERT INTO tasks (id, parent_id, column_id, title, description, duration_minutes, orders, created_at, updated_at, archived_at)
     VALUES (@id, @parentId, @columnId, @title, @description, @durationMinutes, @orders, @createdAt, @updatedAt, @archivedAt)`,
  ).run({
    id,
    parentId: options.parentId ?? null,
    columnId: options.columnId,
    title: options.title,
    description: options.description ?? '',
    orders: options.orders,
    durationMinutes: options.durationMinutes ?? null,
    createdAt: FIXED_TIME,
    updatedAt: options.updatedAt ?? FIXED_TIME,
    archivedAt: options.archived ? FIXED_TIME : null,
  });
  return id;
}
