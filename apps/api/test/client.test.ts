import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';

/**
 * `openDatabase` 的两条路径。
 *
 * 为什么值得单独一个文件：单测一直只用 `:memory:`（helpers 的 createTestDb），于是**文件路径**
 * 那条分支从未执行过——而它才是生产和命令行默认走的那条（`~/.mailuo/kanban.db`）。这条分支里
 * 有一次 `mkdirSync(..., { recursive: true })`：少了它会在一台没建过 `~/.mailuo/` 的机器上
 * 直接抛 ENOENT，而这正是新用户第一次运行 `mailuo` 的路径。
 */

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it(':memory: 不碰文件系统，连接可用且外键是开的', () => {
    const db = openDatabase(':memory:');

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('文件路径会先补建父目录，再建库', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mailuo-client-'));
    created.push(root);
    // 两级都不存在：模拟 `~/.mailuo/` 还没建过的新机器。
    const dbPath = path.join(root, 'nested', 'mailuo', 'kanban.db');

    const db = openDatabase(dbPath);

    expect(existsSync(dbPath)).toBe(true);
    // WAL 是迁移之外的启动约定：文件库必须落在 WAL（见 db/client.ts 的注释）。
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    // 建过表才算真的可用，而不是只创建了一个空文件。
    db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO probe (id) VALUES (?)').run('x');
    expect(db.prepare('SELECT id FROM probe').get()).toEqual({ id: 'x' });
    db.close();
  });
});
