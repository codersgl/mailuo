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
  it('默认端口是 3001，数据库指向 ~/.mailuo/kanban.db', () => {
    const config = loadConfig({ HOME: '/home/someone' });

    expect(config.port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(3001);
    expect(config.dbPath).toBe(path.join('/home/someone', '.mailuo', 'kanban.db'));
    expect(config.migrationsDir.endsWith(path.join('apps', 'api', 'migrations'))).toBe(true);
  });

  it('默认库与命令行入口 bin/mailuo.mjs 的默认库是同一个文件', async () => {
    // 这条是「同一个默认值写了两份」的唯一防线。曾经两份单测各自全绿，而命令行用
    // ~/.mailuo/kanban.db、服务端用 <仓库>/data/kanban.db——用户看到的是「两个库」，
    // dev 里建的任务在 mailuo 里看不见。任何一侧改了路径，这里必须断。
    // bin/mailuo.mjs 是发布给命令行用户的纯 JS 文件，没有类型声明，tsc 报 TS7016。本用例只读它
    // 一个导出的返回值，形状由下面的断言在运行期验证，所以这个压制不会掩盖任何真问题；哪天 bin
    // 有了声明文件，这行压制会因「未使用」自己报错，正好提示删掉它。
    // @ts-expect-error -- 纯 JS 模块没有类型声明（TS7016）
    const cli = await import('../../../bin/mailuo.mjs');

    const withHome = { HOME: '/home/someone' };
    expect(loadConfig(withHome).dbPath).toBe(cli.defaultDbPath(withHome));

    // HOME 缺失时的回落顺序也要一致，否则「有 HOME」与「只有 USERPROFILE」的机器又各走一边。
    const withoutHome = { USERPROFILE: 'C:\\Users\\someone' };
    expect(loadConfig(withoutHome).dbPath).toBe(cli.defaultDbPath(withoutHome));
  });

  it('环境变量可覆盖端口与数据库路径', () => {
    const config = loadConfig({ PORT: '4567', KANBAN_DB_PATH: '/tmp/kanban-test.db' });

    expect(config.port).toBe(4567);
    expect(config.dbPath).toBe('/tmp/kanban-test.db');
  });

  it('KANBAN_DB_PATH 是空串时报错，不静默打开临时库', () => {
    // 不拦的后果比 HOST 隐蔽得多：`??` 只挡 null/undefined，空串会走到 `new Database('')`，
    // 而 SQLite 对空文件名开的是一个私有临时库——服务能起、能写、不报错，重启后数据全丢。
    // 命令行入口早就是这个口径（bin/mailuo.mjs：「数据库路径不能为空」）。
    expect(() => loadConfig({ KANBAN_DB_PATH: '' })).toThrow(/KANBAN_DB_PATH/);
    expect(() => loadConfig({ KANBAN_DB_PATH: '   ' })).toThrow(/KANBAN_DB_PATH/);
    // 真实路径不能被这条校验误伤。
    expect(loadConfig({ KANBAN_DB_PATH: '/tmp/x.db' }).dbPath).toBe('/tmp/x.db');
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

  it('HOST_ALLOW 解析成主机名列表，缺省为空', () => {
    // 用机器名/域名跨设备访问时要显式列进来；用 IP 访问由启动方枚举网卡地址覆盖。
    expect(loadConfig({}).hostAllow).toEqual([]);
    expect(loadConfig({ HOST_ALLOW: 'kanban.local, 100.65.77.53' }).hostAllow).toEqual([
      'kanban.local',
      '100.65.77.53',
    ]);
    expect(loadConfig({ HOST_ALLOW: ' , ' }).hostAllow).toEqual([]);
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
