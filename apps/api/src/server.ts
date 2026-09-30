import path from 'node:path';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { formatHostForUrl, isLoopbackListenHost, isWildcardHost } from './domain/net.js';

/**
 * 服务端启动流程。
 *
 * 为什么从 `index.ts` 抽出来：入口脚本没法在 vitest 里直接执行（它是顶层副作用，只由 bin 的
 * 进程级用例跑过），于是「HOST 白名单怎么合并」「端口被占提示什么」「收到 SIGINT 先关谁」这些
 * 约定在过去没有任何自动化证据，`index.ts` 长期 0%。搬到这里之后，外部依赖全部由调用方注入，
 * 纯逻辑（日志文案、错误分支）单独可测，`index.ts` 只剩「接上真实实现并调用一次」。
 *
 * 这里不提供真实依赖的默认值：真实接线是组合根（`index.ts`）的职责。让默认值留在这里，等于把
 * 一批「只有真起服务才会执行」的闭包藏进本模块，用例覆盖率会显示成 50% 上下的假象，也分不清
 * 哪些逻辑有证据、哪些只是接线。
 *
 * 不改变任何用户可见行为：日志文案、顺序、退出码、信号处理与重构前逐字一致。
 */

/** 启动流程只需要应用的 fetch；注入替身时不必搬来 Hono 的完整类型。 */
export interface AppLike {
  fetch: (request: Request) => Response | Promise<Response>;
}

/** serve() 返回句柄里启动流程真正用到的两个方法。 */
export interface ServerHandle {
  on(event: 'error', handler: (error: NodeJS.ErrnoException) => void): unknown;
  close(callback: () => void): unknown;
}

/** `serve` 的形状。测试里用普通对象替身，不必构造真的 http server。 */
export type ServeLike = (
  options: { fetch: AppLike['fetch']; port: number; hostname: string },
  onListen: (info: { port: number }) => void,
) => ServerHandle;

/**
 * 启动流程用到的全部外部依赖。真实实现由 `index.ts` 接上，用例只覆盖自己关心的那几项。
 */
export interface StartupDeps {
  /** 读仓库根 `.env`（可选文件）。 */
  loadEnvFileIfPresent: () => void;
  loadConfig: () => Config;
  openDatabase: (dbPath: string) => Db;
  runMigrations: (db: Db, migrationsDir: string) => string[];
  reconcileDerivedStatus: (db: Db, now: string) => void;
  /** 本机所有网卡地址，用来给 Host 白名单兜底。 */
  collectLocalAddresses: () => string[];
  fileExists: (filePath: string) => boolean;
  createApp: (
    db: Db,
    options: { host: string; allowedHosts: string[]; staticRoot?: string },
  ) => AppLike;
  serve: ServeLike;
  now: () => string;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (...args: unknown[]) => void;
  closeDatabase: (db: Db) => void;
  exit: (code: number) => void;
  onSignal: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
}

/**
 * 启动时用到的纯逻辑：把本机网卡地址与 `HOST_ALLOW` 合成一份去重名单。
 *
 * 为什么连 IP 也要枚举：`HOST=0.0.0.0` 时手机是用 `http://192.168.1.5:3003` 访问的，Host 就是
 * 那个网卡地址；不枚举的话只能「通配就一律放行」，而那会把 DNS rebinding 那道锁一起放开——
 * 两者是完全不同的攻击面（见 docs/decisions.md D55）。
 */
export function mergeAllowedHosts(
  localAddresses: readonly string[],
  hostAllow: readonly string[],
): string[] {
  return [...new Set([...localAddresses, ...hostAllow])];
}

/**
 * 没有前端产物时的那行提示。判定放在启动时而不是每次请求：这样 createApp 不必碰文件系统，
 * 开发态（还没构建过前端）也不会让 serveStatic 打一行英文告警。代价是「服务跑着的时候跑
 * pnpm build」不会当场生效，要重启一次——README 的生产段落写明了顺序。
 */
export function missingWebBuildMessage(webIndexPath: string): string {
  return `未找到前端产物 ${webIndexPath}，本次只提供 API；跑一次 pnpm build 再重启即可托管页面。`;
}

/** 监听成功后要打印的一行。level 决定走 log 还是 warn，顺序即输出顺序。 */
export interface StartupLine {
  level: 'log' | 'warn';
  text: string;
}

/**
 * 监听成功后的日志行，按输出顺序排列。
 *
 * 顺序是有意的（重构前就是这个顺序，逐字保留）：先报监听地址；监听非本机地址时紧接着给出
 * 安全提醒——那是用户最需要立刻看到的一句话；通配监听再列放行名单；最后是数据库与页面目录。
 */
export function listeningLines(
  config: Config,
  port: number,
  allowedHosts: readonly string[],
  serveWeb: boolean,
): StartupLine[] {
  const lines: StartupLine[] = [
    { level: 'log', text: `API 监听 http://${formatHostForUrl(config.host)}:${port}` },
  ];
  if (!isLoopbackListenHost(config.host)) {
    lines.push({
      level: 'warn',
      text:
        `注意：HOST=${config.host} 让 API 监听非本机地址，而接口没有鉴权——` +
        '同网段（含 Tailscale）的设备可以读写全部任务。只在本机用请删掉 HOST。',
    });
  }
  // 通配监听下 Host/Origin 只放行回环名与下面这些地址；用户用机器名/域名访问时要自己加。
  if (isWildcardHost(config.host)) {
    const listed = allowedHosts.map(formatHostForUrl).join('、');
    lines.push({
      level: 'log',
      text: `放行的 Host：回环名、${listed}（还需要的名字请设 HOST_ALLOW）`,
    });
  }
  lines.push({ level: 'log', text: `数据库: ${config.dbPath}` });
  if (serveWeb) {
    lines.push({ level: 'log', text: `页面: ${config.webDistDir}` });
  }
  return lines;
}

/**
 * 监听失败要打印的行。EADDRINUSE 返回两行可操作的提示；其它错误返回空数组，
 * 由调用方把 error 对象原样打出来（那类错误堆栈本身才是线索）。
 *
 * 提示必须指向 .env：端口现在由根目录 .env 同时喂给两个进程（见 docs/decisions.md D41），
 * 只给 dev:api 加 `PORT=` 前缀的话前端代理还指着旧端口，结果是「后端起来了、前端一直 404」，
 * 而且没有任何报错指得出原因。
 */
export function listenFailureMessages(error: NodeJS.ErrnoException, port: number): string[] {
  if (error.code !== 'EADDRINUSE') return [];
  return [
    `端口 ${port} 已被占用。换端口请改根目录 .env 的 PORT，然后重启 dev:api 与 dev:web。`,
    '只给某一个进程加 PORT= 前缀会让两端不一致，表现为前端一直 404。',
  ];
}

/**
 * 起服务，返回句柄主要给用例断言用。
 *
 * 步骤与重构前 index.ts 的顶层语句逐条对应：
 * 读 .env → 读配置 → 建库 → 合并 Host 白名单 → 迁移 → 给老库对账 → 判断前端产物 → serve →
 * 注册 error 与信号处理。
 */
export function startServer(deps: StartupDeps) {
  // 先读本机 .env（可选），再读配置：这样 `pnpm dev:api` 不带前缀也能拿到 .env 里的 PORT。
  deps.loadEnvFileIfPresent();
  const config = deps.loadConfig();
  const db = deps.openDatabase(config.dbPath);
  const allowedHosts = mergeAllowedHosts(deps.collectLocalAddresses(), config.hostAllow);

  const applied = deps.runMigrations(db, config.migrationsDir);
  if (applied.length > 0) {
    deps.log(`已应用迁移: ${applied.join(', ')}`);
  }

  /**
   * 启动时给老库兜一次底：父任务的列由子任务推导（见 domain/derive.ts），而 0.2.0 及更早的库里
   * 没有这条规则，历史数据大概率与子任务矛盾。每个写入口都会对账，但只读不写的库会一直不自洽，
   * 所以这里先跑一遍。
   *
   * 刻意不做成一条迁移：这个功能没有任何 schema 变化，而推导规则要留在 TypeScript 里
   * （domain/derive.ts 一份实现），搬一份 SQL 进迁移文件就是两份实现，迟早分叉——与
   * domain/clock.ts 的分钟换算「没有搬进 SQL」是同一条理由。对账是幂等的，状态一致时不写一个字节。
   */
  deps.reconcileDerivedStatus(db, deps.now());

  const webIndexPath = path.join(config.webDistDir, 'index.html');
  const serveWeb = deps.fileExists(webIndexPath);
  if (!serveWeb) {
    deps.log(missingWebBuildMessage(webIndexPath));
  }

  const server = deps.serve(
    {
      // hostname 必须显式传：不传时 Node 绑的是 `::`（全部网卡），日志却写着 localhost，
      // 于是一个「个人本机应用」默认对同网段敞开（见 docs/audit-2026-09-23.md 的 A1）。
      fetch: deps.createApp(db, {
        host: config.host,
        allowedHosts,
        staticRoot: serveWeb ? config.webDistDir : undefined,
      }).fetch,
      port: config.port,
      hostname: config.host,
    },
    (info) => {
      for (const line of listeningLines(config, info.port, allowedHosts, serveWeb)) {
        if (line.level === 'warn') deps.warn(line.text);
        else deps.log(line.text);
      }
    },
  );

  // 监听失败（最常见的是端口被占用）会以 error 事件抛出。默认行为是打印一大段堆栈后崩溃，
  // 这里换成一行可操作的提示。
  server.on('error', (error: NodeJS.ErrnoException) => {
    const messages = listenFailureMessages(error, config.port);
    if (messages.length === 0) {
      deps.error('API 启动失败:', error);
    } else {
      for (const message of messages) deps.error(message);
    }
    deps.closeDatabase(db);
    deps.exit(1);
  });

  // 退出前关掉数据库连接，避免 WAL 文件残留未落盘的写入。
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    deps.onSignal(signal, () => {
      server.close(() => {
        deps.closeDatabase(db);
        deps.exit(0);
      });
    });
  }

  return { config, allowedHosts, db, server };
}
