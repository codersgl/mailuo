import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  envFilePath,
  loadConfig,
  loadEnvFileIfPresent,
  repoRoot,
} from '../src/config.js';
import { DEFAULT_HOST } from '../src/domain/net.js';

describe('loadConfig', () => {
  // 这些用例的入参是显式传的对象，不读进程环境，所以 shell 里已有 PORT 也不影响。
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

  it('默认只监听本机，HOST 可显式放开', () => {
    // 默认值就是信任边界：不设 HOST 时 API 只服务本机（见 docs/decisions.md D55）。
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({}).host).toBe(DEFAULT_HOST);
    expect(loadConfig({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ HOST: ' 10.32.213.214 ' }).host).toBe('10.32.213.214');
  });

  it('HOST 是空串时报错，不静默回落默认值', () => {
    // 「设了但没填」与「没设」是两件事：静默用默认值会让用户以为自己放开了监听。
    expect(() => loadConfig({ HOST: '' })).toThrow(/HOST/);
    expect(() => loadConfig({ HOST: '   ' })).toThrow(/HOST/);
  });

  it('端口非法时报错', () => {
    expect(() => loadConfig({ PORT: '不是数字' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('默认读的 .env 就在仓库根目录', () => {
    // 这是「不带前缀启动也能拿到端口」的前提。下面 loadEnvFileIfPresent 的用例都显式传路径，
    // 所以路径推导写错时它们照样全绿，只有真跑 dev:api 才暴露。
    expect(envFilePath).toBe(path.join(repoRoot, '.env'));
    expect(fs.existsSync(path.join(repoRoot, 'package.json'))).toBe(true);
  });
});

describe('loadEnvFileIfPresent', () => {
  // process.loadEnvFile 直接改 process.env。运行环境里本来可能就有 PORT（CI 常常注入），
  // 所以既不能假定初值为空，也不能用「删掉」当清理：先记下真实初值，用完还原。
  const saved: Record<string, string | undefined> = {
    PORT: process.env.PORT,
    KANBAN_DB_PATH: process.env.KANBAN_DB_PATH,
  };
  const tempDirs: string[] = [];

  beforeEach(() => {
    // 每个用例都从「这两个变量不存在」开始，否则测不出 .env 究竟写进去了什么。
    delete process.env.PORT;
    delete process.env.KANBAN_DB_PATH;
  });

  afterEach(() => {
    for (const [key, original] of Object.entries(saved)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
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
