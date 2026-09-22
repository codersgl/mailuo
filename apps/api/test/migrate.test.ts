import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createTestDb, migrationsDir } from './helpers.js';

const tempDirs: string[] = [];

/** 造一个只放指定迁移文件的临时目录。 */
function makeMigrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-migrations-'));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runMigrations', () => {
  it('首次执行应用 001 并写入 schema_migrations', () => {
    const db = openDatabase(':memory:');

    expect(runMigrations(db, migrationsDir)).toEqual(['001_init.sql']);

    const columns = db.prepare('SELECT id, name, orders FROM columns ORDER BY orders').all();
    expect(columns).toEqual([
      { id: 'todo', name: '待办', orders: 1000 },
      { id: 'doing', name: '进行中', orders: 2000 },
      { id: 'done', name: '完成', orders: 3000 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
  });

  it('重复执行不重复应用', () => {
    const db = createTestDb();

    expect(runMigrations(db, migrationsDir)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
  });

  it('打开连接时外键约束生效', () => {
    const db = createTestDb();

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, parent_id, column_id, title, orders, created_at, updated_at)
           VALUES ('t1', NULL, '不存在的列', '标题', 1000, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('迁移失败时整份文件回滚且不记录', () => {
    const db = openDatabase(':memory:');
    const dir = makeMigrationsDir({
      '001_broken.sql': 'CREATE TABLE ok (id TEXT); CREATE TABLE ok (id TEXT);',
    });

    expect(() => runMigrations(db, dir)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
  });

  it('文件名缺数字前缀时报错', () => {
    const db = openDatabase(':memory:');
    const dir = makeMigrationsDir({ 'init.sql': 'SELECT 1;' });

    expect(() => runMigrations(db, dir)).toThrow(/数字前缀/);
  });

  it('编号重复时报错', () => {
    const db = openDatabase(':memory:');
    const dir = makeMigrationsDir({ '001_a.sql': 'SELECT 1;', '001_b.sql': 'SELECT 1;' });

    expect(() => runMigrations(db, dir)).toThrow(/编号重复/);
  });
});
