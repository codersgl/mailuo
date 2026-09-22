import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORT, loadConfig, loadEnvFileIfPresent } from '../src/config.js';

describe('loadConfig', () => {
  it('默认端口是 3001，数据库指向仓库 data/kanban.db', () => {
    const config = loadConfig({});

    expect(config.port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(3001);
    expect(config.dbPath.endsWith(path.join('data', 'kanban.db'))).toBe(true);
    expect(config.migrationsDir.endsWith(path.join('apps', 'api', 'migrations'))).toBe(true);
  });

  it('环境变量可覆盖端口与数据库路径', () => {
    const config = loadConfig({ PORT: '4567', KANBAN_DB_PATH: '/tmp/kanban-test.db' });

    expect(config.port).toBe(4567);
    expect(config.dbPath).toBe('/tmp/kanban-test.db');
  });

  it('端口非法时报错', () => {
    expect(() => loadConfig({ PORT: '不是数字' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });
});

describe('loadEnvFileIfPresent', () => {
  // process.loadEnvFile 直接改 process.env，用完必须还原，否则会污染同一进程里后面的用例。
  const touched = ['PORT', 'KANBAN_DB_PATH'];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const key of touched) {
      delete process.env[key];
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** 造一个只含 .env 的临时目录，返回文件路径。 */
  function writeEnvFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-env-'));
    tempDirs.push(dir);
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, content);
    return file;
  }

  it('.env 里的键值会进到 process.env，进而被 loadConfig 读到', () => {
    const file = writeEnvFile('PORT=4567\nKANBAN_DB_PATH=/tmp/from-env-file.db\n');

    loadEnvFileIfPresent(file);

    expect(process.env.PORT).toBe('4567');
    // 关键的一步：`pnpm dev:api` 不带前缀时也能拿到 .env 里的端口。
    expect(loadConfig().port).toBe(4567);
    expect(loadConfig().dbPath).toBe('/tmp/from-env-file.db');
  });

  it('命令行传的环境变量优先于 .env（process.loadEnvFile 不覆盖已有的值）', () => {
    const file = writeEnvFile('PORT=4567\n');
    process.env.PORT = '9999';

    loadEnvFileIfPresent(file);

    expect(process.env.PORT).toBe('9999');
  });

  it('.env 不存在时静默跳过', () => {
    const missing = path.join(os.tmpdir(), 'kanban-not-exists', '.env');

    expect(() => loadEnvFileIfPresent(missing)).not.toThrow();
    expect(process.env.PORT).toBeUndefined();
  });

  it('文件存在但读不了时照常抛出，不假装成功', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-env-dir-'));
    tempDirs.push(dir);

    // 传目录而不是文件：Node 抛 ERR_INVALID_ARG_TYPE，不是 ENOENT，必须原样抛出去，
    // 不能当成「没有 .env」静默跳过。
    expect(() => loadEnvFileIfPresent(dir)).toThrow();
  });
});
