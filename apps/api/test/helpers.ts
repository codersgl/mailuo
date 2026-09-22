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
  },
): string {
  sequence += 1;
  const id = `task-${sequence}`;
  db.prepare(
    `INSERT INTO tasks (id, parent_id, column_id, title, description, duration, orders, created_at, updated_at, archived_at)
     VALUES (@id, @parentId, @columnId, @title, '', 0, @orders, @createdAt, @updatedAt, @archivedAt)`,
  ).run({
    id,
    parentId: options.parentId ?? null,
    columnId: options.columnId,
    title: options.title,
    orders: options.orders,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    archivedAt: options.archived ? FIXED_TIME : null,
  });
  return id;
}
