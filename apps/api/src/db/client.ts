import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

/** 数据库句柄类型别名，避免每个模块都 import 一次 better-sqlite3。 */
export type Db = DatabaseHandle;

/**
 * 打开 SQLite 连接。
 * - `journal_mode = WAL`：读写并发更友好，个人使用下也便于备份。
 * - `foreign_keys = ON`：better-sqlite3 默认关闭外键，必须在每个连接上显式打开（见 docs/spec.md）。
 */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
