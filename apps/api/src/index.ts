import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig, loadEnvFileIfPresent } from './config.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { collectLocalAddresses, formatHostForUrl, isLoopbackListenHost, isWildcardHost } from './domain/net.js';
import { reconcileDerivedStatus } from './repositories/tasks.js';

// 先读本机 .env（可选），再读配置：这样 `pnpm dev:api` 不带前缀也能拿到 .env 里的 PORT。
loadEnvFileIfPresent();

const config = loadConfig();
const db = openDatabase(config.dbPath);

/**
 * Host 白名单里额外放行的名字：本机所有网卡地址 + `HOST_ALLOW` 里用户自己列的名字。
 *
 * 为什么连 IP 也要枚举：`HOST=0.0.0.0` 时手机是用 `http://192.168.1.5:3003` 访问的，
 * Host 就是那个网卡地址；不枚举的话只能「通配就一律放行」，而那会把 DNS rebinding 那道锁
 * 一起放开——两者是完全不同的攻击面（见 docs/decisions.md D55）。
 */
const allowedHosts = [
  ...new Set([...collectLocalAddresses(os.networkInterfaces()), ...config.hostAllow]),
];

const applied = runMigrations(db, config.migrationsDir);
if (applied.length > 0) {
  console.log(`已应用迁移: ${applied.join(', ')}`);
}

/**
 * 启动时给老库兜一次底：父任务的列由子任务推导（见 domain/derive.ts），而 0.2.0 及更早的库里
 * 没有这条规则，历史数据大概率与子任务矛盾。每个写入口都会对账，但只读不写的库会一直不自洽，
 * 所以这里先跑一遍。
 *
 * 刻意不做成一条迁移：这个功能没有任何 schema 变化，而推导规则要留在 TypeScript 里
 * （domain/derive.ts 一份实现），搬一份 SQL 进迁移文件就是两份实现，迟早分叉——这与
 * domain/clock.ts 的分钟换算「没有搬进 SQL」是同一条理由。对账是幂等的，状态一致时不写一个字节。
 */
reconcileDerivedStatus(db, new Date().toISOString());

/**
 * 有没有前端产物可托管：只看 `index.html` 在不在。
 *
 * 判定放在启动时而不是每次请求：这样 `createApp` 不必碰文件系统，开发态（还没构建过前端）
 * 也不会让 serveStatic 打一行英文告警。代价是「服务跑着的时候跑 pnpm build」不会当场生效，
 * 要重启一次——README 的生产段落写明了顺序。
 */
const webIndexPath = path.join(config.webDistDir, 'index.html');
const serveWeb = existsSync(webIndexPath);
if (!serveWeb) {
  console.log(`未找到前端产物 ${webIndexPath}，本次只提供 API；跑一次 pnpm build 再重启即可托管页面。`);
}

const server = serve(
  /**
   * hostname 必须显式传：不传时 Node 绑的是 `::`（全部网卡），日志却写着 localhost，
   * 于是一个「个人本机应用」默认对同网段敞开（见 docs/audit-2026-09-23.md 的 A1）。
   * 现在默认 `127.0.0.1`，跨设备访问要自己设 HOST（见 docs/decisions.md D55）。
   */
  {
    fetch: createApp(db, {
      host: config.host,
      allowedHosts,
      staticRoot: serveWeb ? config.webDistDir : undefined,
    }).fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(`API 监听 http://${formatHostForUrl(config.host)}:${info.port}`);
    if (!isLoopbackListenHost(config.host)) {
      console.warn(
        `注意：HOST=${config.host} 让 API 监听非本机地址，而接口没有鉴权——` +
          '同网段（含 Tailscale）的设备可以读写全部任务。只在本机用请删掉 HOST。',
      );
    }
    // 通配监听下 Host/Origin 只放行回环名与下面这些地址；用户用机器名/域名访问时要自己加。
    if (isWildcardHost(config.host)) {
      const listed = allowedHosts.map(formatHostForUrl).join('、');
      console.log(`放行的 Host：回环名、${listed}（还需要的名字请设 HOST_ALLOW）`);
    }
    console.log(`数据库: ${config.dbPath}`);
    if (serveWeb) {
      console.log(`页面: ${config.webDistDir}`);
    }
  },
);

// 监听失败（最常见的是端口被占用）会以 error 事件抛出。默认行为是打印一大段堆栈后崩溃，
// 这里换成一行可操作的提示。
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    // 提示必须指向 .env：端口现在由根目录 .env 同时喂给两个进程（见 docs/decisions.md D41），
    // 只给 dev:api 加 `PORT=` 前缀的话，前端代理还指着 .env 里的旧端口，
    // 结果是「后端起来了、前端一直 404」，而且没有任何报错指得出原因。
    console.error(
      `端口 ${config.port} 已被占用。换端口请改根目录 .env 的 PORT，然后重启 dev:api 与 dev:web。`,
    );
    console.error('只给某一个进程加 PORT= 前缀会让两端不一致，表现为前端一直 404。');
  } else {
    console.error('API 启动失败:', error);
  }
  db.close();
  process.exit(1);
});

// 退出前关掉数据库连接，避免 WAL 文件残留未落盘的写入。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
