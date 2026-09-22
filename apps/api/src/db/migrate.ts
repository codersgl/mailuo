import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './client.js';

const MIGRATION_TABLE = 'schema_migrations';

/**
 * 需要重建表的迁移（SQLite 改不了已有列的类型与约束）必须在外键关闭的情况下执行：
 * 重建过程会 DROP 掉被其它表引用的旧表，外键打开时那条 DROP 会触发隐式 DELETE 并报约束错误。
 * `PRAGMA foreign_keys` 在事务内是空操作，所以只能由 runner 在事务外开关，
 * 迁移文件里用这一行标记声明（见 docs/decisions.md D31）。
 */
const NO_FOREIGN_KEYS_MARKER = /^--\s*kanban:no-foreign-keys\s*$/m;

/**
 * 按文件名数字前缀升序执行未应用过的迁移，返回本次执行的迁移文件名。
 *
 * 每个迁移文件在独立事务中执行：SQL 失败时整个文件回滚，且不会写入 schema_migrations，
 * 下次启动会重试。因此迁移文件内不要自己写 BEGIN/COMMIT（嵌套事务会报错）。
 * 迁移只向前追加，不提供回滚。
 */
export function runMigrations(db: Db, migrationsDir: string): string[] {
  // 被外层事务包住时 `PRAGMA foreign_keys` 是空操作，标记会静默失效——宁可在这里就报错。
  if (db.inTransaction) {
    throw new Error('runMigrations 不能在事务里执行：PRAGMA foreign_keys 在事务内不生效');
  }

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
    // 只认整行的标记，避免说明性注释里提到这个字符串就误关外键保护。
    const needsForeignKeysOff = NO_FOREIGN_KEYS_MARKER.test(sql);

    if (needsForeignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        // 校验放在提交前：留下悬空引用时整个文件回滚，而不是把一个坏掉的库留在磁盘上。
        if (needsForeignKeysOff) assertNoForeignKeyViolations(db, file);
        db.prepare(`INSERT INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`).run(
          file,
          new Date().toISOString(),
        );
      })();
    } finally {
      // 无论成功失败都要恢复，否则之后的写操作都会失去外键保护。
      if (needsForeignKeysOff) db.pragma('foreign_keys = ON');
    }
    executed.push(file);
  }
  return executed;
}

/**
 * 重建表之后确认没有留下悬空引用。`PRAGMA foreign_key_check` 无违规时返回空数组。
 * 检查是全库范围的：它不只兜住本次重建，也会拦下迁移之前就存在的坏数据。
 * 这里刻意选择「响亮地失败」而不是跳过——带着悬空引用的库继续跑，问题只会更晚更难查。
 * 恢复方式：错误信息里有具体的表与 rowid，修好那些行再重启，迁移会重试。
 */
function assertNoForeignKeyViolations(db: Db, file: string): void {
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `迁移 ${file} 留下了悬空的外键引用: ${JSON.stringify(violations)}。` +
        '先修好这些行再重启（迁移已回滚，会在下次启动时重试）',
    );
  }
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
