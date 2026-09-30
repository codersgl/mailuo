import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import {
  listenFailureMessages,
  listeningLines,
  mergeAllowedHosts,
  missingWebBuildMessage,
  startServer,
} from '../src/server.js';
import type { StartupDeps } from '../src/server.js';

/**
 * 启动流程（src/server.ts）的用例。
 *
 * 为什么值得单独一组：这些行为以前散在 `src/index.ts` 的顶层语句里，而入口脚本没有任何用例
 * （0%），于是「HOST=0.0.0.0 要打印放行名单」「端口被占要指向 .env」「收到 SIGINT 要先关库再退出」
 * 这些对用户可见的约定没有自动化证据。抽出 `startServer(deps)` 之后，这里用替身把每条都钉住，
 * 真起服务仍由 bin 的进程级用例负责。
 */

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 3001,
    host: '127.0.0.1',
    hostAllow: [],
    dbPath: '/tmp/mailuo/kanban.db',
    migrationsDir: '/repo/apps/api/migrations',
    webDistDir: '/repo/apps/web/dist',
    ...overrides,
  };
}

/** 一份全替身的启动依赖；每条用例只覆盖自己关心的那几项。 */
function makeDeps(overrides: Partial<StartupDeps> = {}) {
  const server = { on: vi.fn(), close: vi.fn() };
  const deps: StartupDeps = {
    loadEnvFileIfPresent: vi.fn(),
    loadConfig: vi.fn(() => config()),
    openDatabase: vi.fn(() => ({}) as never),
    runMigrations: vi.fn(() => []),
    reconcileDerivedStatus: vi.fn(),
    collectLocalAddresses: vi.fn(() => []),
    fileExists: vi.fn(() => false),
    createApp: vi.fn(() => ({ fetch: vi.fn() })),
    serve: vi.fn(() => server),
    now: vi.fn(() => '2026-09-30T00:00:00.000Z'),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    closeDatabase: vi.fn(),
    exit: vi.fn(),
    onSignal: vi.fn(),
    ...overrides,
  };
  return { deps, server };
}

/** 取 serve 收到的 onListen 回调，模拟「监听成功」。 */
function listenCallback(deps: StartupDeps) {
  const call = (deps.serve as ReturnType<typeof vi.fn>).mock.calls[0];
  if (call === undefined) throw new Error('serve 没有被调用');
  return call[1] as (info: { port: number }) => void;
}

/** 取 server.on('error', ...) 注册的处理函数。 */
function errorHandler(server: { on: ReturnType<typeof vi.fn> }) {
  const call = server.on.mock.calls.find(([event]) => event === 'error');
  if (call === undefined) throw new Error('没有注册 error 处理函数');
  return call[1] as (error: NodeJS.ErrnoException) => void;
}

/**
 * 某个 vi.fn 依赖第一次被调用的序号，用来断言「先关库再退出」这类**顺序**。
 * 依赖在 StartupDeps 里是普通函数类型，拿不到 vitest 的 mock 字段，这里收窄一次。
 */
function callIndex(fn: unknown): number {
  return (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0] ?? -1;
}

describe('mergeAllowedHosts', () => {
  it('把本机地址与 HOST_ALLOW 合成一份去重的名单，保持先本机后配置的顺序', () => {
    expect(mergeAllowedHosts(['127.0.0.1', '192.168.1.5'], ['sgl.local', '127.0.0.1'])).toEqual([
      '127.0.0.1',
      '192.168.1.5',
      'sgl.local',
    ]);
  });

  it('两边都空时返回空名单，不抛错', () => {
    expect(mergeAllowedHosts([], [])).toEqual([]);
  });
});

describe('missingWebBuildMessage', () => {
  it('写明缺的是哪个文件与修复命令', () => {
    const message = missingWebBuildMessage('/repo/apps/web/dist/index.html');

    expect(message).toContain('/repo/apps/web/dist/index.html');
    expect(message).toContain('pnpm build');
    expect(message).toContain('只提供 API');
  });
});

describe('listeningLines', () => {
  it('本机监听：只有监听地址与数据库两行，没有警告', () => {
    expect(listeningLines(config(), 3001, [], false)).toEqual([
      { level: 'log', text: 'API 监听 http://127.0.0.1:3001' },
      { level: 'log', text: '数据库: /tmp/mailuo/kanban.db' },
    ]);
  });

  it('托管前端时多一行页面目录', () => {
    const lines = listeningLines(config(), 3001, [], true);

    expect(lines.at(-1)).toEqual({ level: 'log', text: '页面: /repo/apps/web/dist' });
  });

  it('监听非本机地址时给出安全提醒，且排在监听地址之后', () => {
    const lines = listeningLines(config({ host: '0.0.0.0' }), 3003, [], false);

    expect(lines[0]).toEqual({ level: 'log', text: 'API 监听 http://0.0.0.0:3003' });
    expect(lines[1]?.level).toBe('warn');
    expect(lines[1]?.text).toContain('HOST=0.0.0.0');
    expect(lines[1]?.text).toContain('没有鉴权');
  });

  it('通配监听时列出放行名单，IPv6 地址带方括号', () => {
    const lines = listeningLines(config({ host: '::' }), 3001, ['127.0.0.1', '::1'], false);
    const listed = lines.find((line) => line.text.startsWith('放行的 Host'));

    // 名单里是主机名本身（不带 scheme/端口），IPv6 由 formatHostForUrl 加方括号，
    // 避免 `::1:3001` 这种「地址还是端口」的歧义。
    expect(listed?.text).toContain('127.0.0.1');
    expect(listed?.text).toContain('[::1]');
    expect(listed?.text).toContain('HOST_ALLOW');
  });

  it('具体地址（非通配）不打印放行名单', () => {
    const lines = listeningLines(config({ host: '192.168.1.5' }), 3001, ['a.local'], false);

    expect(lines.some((line) => line.text.startsWith('放行的 Host'))).toBe(false);
  });
});

describe('listenFailureMessages', () => {
  it('EADDRINUSE 给两行可操作的提示，指向 .env', () => {
    const messages = listenFailureMessages({ code: 'EADDRINUSE' } as NodeJS.ErrnoException, 3001);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('3001');
    expect(messages[0]).toContain('.env');
    expect(messages[1]).toContain('404');
  });

  it('其它错误返回空数组，交给调用方原样打印 error 对象', () => {
    expect(listenFailureMessages({ code: 'EACCES' } as NodeJS.ErrnoException, 3001)).toEqual([]);
  });
});

describe('startServer', () => {
  it('先读 .env 再读配置：命令行前缀才能压过文件', () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      loadEnvFileIfPresent: vi.fn(() => void order.push('env')),
      loadConfig: vi.fn(() => {
        order.push('config');
        return config();
      }),
    });

    startServer(deps);

    expect(order).toEqual(['env', 'config']);
  });

  it('本机网卡地址与 HOST_ALLOW 合并后交给 createApp，杂项按顺序落地', () => {
    const { deps } = makeDeps({
      collectLocalAddresses: vi.fn(() => ['127.0.0.1', '192.168.1.5']),
      loadConfig: vi.fn(() => config({ hostAllow: ['sgl.local'], host: '0.0.0.0' })),
      fileExists: vi.fn(() => true),
      runMigrations: vi.fn(() => ['003_x.sql', '004_y.sql']),
    });

    startServer(deps);

    // 迁移有内容才打日志，且与「是否托管前端」无关。
    expect(deps.log).toHaveBeenCalledWith('已应用迁移: 003_x.sql, 004_y.sql');
    // 建库用的是配置里的库路径，不是别的目录（传错会被「服务照样起来」掩盖）。
    expect(deps.openDatabase).toHaveBeenCalledWith('/tmp/mailuo/kanban.db');
    expect(deps.reconcileDerivedStatus).toHaveBeenCalledWith(
      expect.anything(),
      '2026-09-30T00:00:00.000Z',
    );
    const appOptions = (deps.createApp as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(appOptions).toEqual({
      host: '0.0.0.0',
      allowedHosts: ['127.0.0.1', '192.168.1.5', 'sgl.local'],
      staticRoot: '/repo/apps/web/dist',
    });
  });

  it('没有迁移时不打那一行，也不把不存在的产物目录交给 createApp', () => {
    const { deps } = makeDeps({
      runMigrations: vi.fn(() => []),
      fileExists: vi.fn(() => false),
    });

    startServer(deps);

    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('已应用迁移'));
    expect(deps.log).toHaveBeenCalledWith(missingWebBuildMessage('/repo/apps/web/dist/index.html'));
    const appOptions = (deps.createApp as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(appOptions?.staticRoot).toBeUndefined();
  });

  it('把端口与监听地址交给 serve，监听成功后按行打印', () => {
    const { deps } = makeDeps({ loadConfig: vi.fn(() => config({ port: 3010, host: '0.0.0.0' })) });

    startServer(deps);
    const serveOptions = (deps.serve as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      fetch: unknown;
      port: number;
      hostname: string;
    };
    expect(serveOptions).toMatchObject({ port: 3010, hostname: '0.0.0.0' });
    // serve 收到的必须是 createApp 返回的那个 fetch，不是另接一个（接错时请求会绕过整条中间件）。
    const created = (deps.createApp as ReturnType<typeof vi.fn>).mock.results[0]?.value as {
      fetch: unknown;
    };
    expect(serveOptions.fetch).toBe(created.fetch);

    listenCallback(deps)({ port: 3010 });

    expect(deps.log).toHaveBeenCalledWith('API 监听 http://0.0.0.0:3010');
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('没有鉴权'));
  });

  it('端口被占：打印 CLI 的两行提示、关库、以 1 退出', () => {
    const { deps, server } = makeDeps();

    const { db } = startServer(deps);
    errorHandler(server)({ code: 'EADDRINUSE' } as NodeJS.ErrnoException);

    // 两行都要打：第一行指出端口与 .env，第二行解释「只给一个进程加前缀」的后果。
    expect(deps.error).toHaveBeenCalledTimes(2);
    expect(deps.error).toHaveBeenNthCalledWith(1, expect.stringContaining('3001'));
    expect(deps.error).toHaveBeenNthCalledWith(2, expect.stringContaining('404'));
    // 先关库再退出：反过来的话 WAL 里可能留着没落盘的写入（重构前就是先关后退出）。
    expect(deps.closeDatabase).toHaveBeenCalledWith(db);
    expect(callIndex(deps.closeDatabase)).toBeLessThan(callIndex(deps.exit));
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('其它监听错误：原样打印 error 对象，同样关库退出', () => {
    const { deps, server } = makeDeps();
    const failure = { code: 'EACCES' } as NodeJS.ErrnoException;

    const { db } = startServer(deps);
    errorHandler(server)(failure);

    expect(deps.error).toHaveBeenCalledWith('API 启动失败:', failure);
    expect(deps.closeDatabase).toHaveBeenCalledWith(db);
    expect(callIndex(deps.closeDatabase)).toBeLessThan(callIndex(deps.exit));
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('注册 SIGINT 与 SIGTERM：先关服务，再关库并以 0 退出', () => {
    const { deps, server } = makeDeps();
    // close 的回调由真实 http server 在连接排空后调用，这里让替身立刻回调。
    server.close.mockImplementation((callback: () => void) => callback());

    const { db } = startServer(deps);

    const signals = (deps.onSignal as ReturnType<typeof vi.fn>).mock.calls.map(([signal]) => signal);
    expect(signals).toEqual(['SIGINT', 'SIGTERM']);

    const handler = (deps.onSignal as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as () => void;
    handler();

    expect(server.close).toHaveBeenCalledTimes(1);
    // 关库与退出的顺序同样是行为的一部分：先 close 库再 exit，WAL 才有机会收尾。
    expect(deps.closeDatabase).toHaveBeenCalledWith(db);
    expect(callIndex(deps.closeDatabase)).toBeLessThan(callIndex(deps.exit));
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});
