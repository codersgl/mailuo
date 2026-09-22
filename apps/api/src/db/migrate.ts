import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './client.js';

const MIGRATION_TABLE = 'schema_migrations';

/**
 * 按文件名数字前缀升序执行未应用过的迁移，返回本次执行的迁移文件名。
 *
 * 每个迁移文件在独立事务中执行：SQL 失败时整个文件回滚，且不会写入 schema_migrations，
 * 下次启动会重试。因此迁移文件内不要自己写 BEGIN/COMMIT（嵌套事务会报错）。
 * 迁移只向前追加，不提供回滚。
 */
export function runMigrations(db: Db, migrationsDir: string): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare(`SELECT name FROM ${MIGRATION_TABLE}`)
      .all()
      .map((row) => (row as { name: string }).name),
  );

  const executed: string[] = [];
  for (const file of listMigrationFiles(migrationsDir)) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`).run(
        file,
        new Date().toISOString(),
      );
    })();
    executed.push(file);
  }
  return executed;
}

/** 文件名形如 `001_init.sql`，按数字前缀升序。前缀缺失或重复都在这里直接报错。 */
function listMigrationFiles(migrationsDir: string): string[] {
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'));
  const withNumber = files.map((file) => {
    const match = /^(\d+)_/.exec(file);
    if (!match?.[1]) {
      throw new Error(`迁移文件名必须以数字前缀加下划线开头，例如 001_init.sql: ${file}`);
    }
    return { file, number: Number(match[1]) };
  });

  withNumber.sort((a, b) => a.number - b.number);

  for (let i = 1; i < withNumber.length; i += 1) {
    if (withNumber[i]!.number === withNumber[i - 1]!.number) {
      throw new Error(`迁移编号重复: ${withNumber[i - 1]!.file} 与 ${withNumber[i]!.file}`);
    }
  }
  return withNumber.map((item) => item.file);
}
