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
  it('首次执行应用全部迁移并写入 schema_migrations', () => {
    const db = openDatabase(':memory:');

    expect(runMigrations(db, migrationsDir)).toEqual(['001_init.sql', '002_duration_minutes.sql']);

    const columns = db.prepare('SELECT id, name, orders FROM columns ORDER BY orders').all();
    expect(columns).toEqual([
      { id: 'todo', name: '待办', orders: 1000 },
      { id: 'doing', name: '进行中', orders: 2000 },
      { id: 'done', name: '完成', orders: 3000 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 2 });
  });

  it('重复执行不重复应用', () => {
    const db = createTestDb();

    expect(runMigrations(db, migrationsDir)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 2 });
  });

  it('新增的迁移只应用新增的那一个', () => {
    const db = openDatabase(':memory:');
    const dir = makeMigrationsDir({ '001_a.sql': 'CREATE TABLE a (id TEXT);' });
    expect(runMigrations(db, dir)).toEqual(['001_a.sql']);

    fs.writeFileSync(path.join(dir, '002_b.sql'), 'CREATE TABLE b (id TEXT);');

    expect(runMigrations(db, dir)).toEqual(['002_b.sql']);
    expect(runMigrations(db, dir)).toEqual([]);
    expect(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all()).toEqual([
      { name: '001_a.sql' },
      { name: '002_b.sql' },
    ]);
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

  it('002 把工期从天折算成分钟，并把旧的 0（未估）转成 NULL', () => {
    // 先用只有 001 的目录造出旧结构的数据，再补上 002 走一次真实的升级路径。
    const onlyInit = makeMigrationsDir({
      '001_init.sql': fs.readFileSync(path.join(migrationsDir, '001_init.sql'), 'utf8'),
    });
    const db = openDatabase(':memory:');
    expect(runMigrations(db, onlyInit)).toEqual(['001_init.sql']);
    db.prepare(
      `INSERT INTO tasks (id, parent_id, column_id, title, description, duration, orders, created_at, updated_at)
       VALUES ('p', NULL, 'todo', '父任务', '', 5, 1000, 't', 't'),
              ('c', 'p', 'doing', '子任务', '', 0, 1000, 't', 't'),
              ('n', NULL, 'todo', '脏数据', '', -3, 2000, 't', 't')`,
    ).run();
    db.prepare(`INSERT INTO task_deps (predecessor_id, successor_id) VALUES ('p', 'c')`).run();

    fs.copyFileSync(
      path.join(migrationsDir, '002_duration_minutes.sql'),
      path.join(onlyInit, '002_duration_minutes.sql'),
    );
    expect(runMigrations(db, onlyInit)).toEqual(['002_duration_minutes.sql']);

    expect(db.prepare('SELECT id, duration_minutes FROM tasks ORDER BY id').all()).toEqual([
      { id: 'c', duration_minutes: null },
      // 001 没有 CHECK，手改库可能留下负数；负数按「未估」处理，不能让迁移永久失败。
      { id: 'n', duration_minutes: null },
      { id: 'p', duration_minutes: 2400 },
    ]);
    // 重建表不能动依赖、索引和外键：这三样都断言一遍。
    expect(db.prepare('SELECT * FROM task_deps').all()).toEqual([
      { predecessor_id: 'p', successor_id: 'c' },
    ]);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_tasks_board', 'idx_tasks_parent']));
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    const columns = db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain('duration_minutes');
    expect(columns).not.toContain('duration');

    // 重建（DROP + RENAME）最容易出的事故是把引用指错表，这里钉死 task_deps 的外键仍然生效。
    expect(() =>
      db.prepare(`INSERT INTO task_deps (predecessor_id, successor_id) VALUES ('p', '不存在')`).run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('标记了 no-foreign-keys 的迁移留下悬空引用时报错、整份回滚，并恢复外键开关', () => {
    const db = openDatabase(':memory:');
    const dir = makeMigrationsDir({
      '001_dangling.sql': `-- kanban:no-foreign-keys
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));
        INSERT INTO parent (id) VALUES ('p');
        INSERT INTO child (id, parent_id) VALUES ('c', 'p');
        DELETE FROM parent;`,
    });

    expect(() => runMigrations(db, dir)).toThrow(/悬空的外键引用/);
    // 外键开关必须恢复，否则之后的写入都没有保护。
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // 校验在提交前做，所以整份文件回滚：建表语句也一起撤销了，迁移没被记录。
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'parent'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 0 });
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
