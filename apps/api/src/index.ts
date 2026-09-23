import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig, loadEnvFileIfPresent } from './config.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { hostNameOf, isLoopbackHostName } from './domain/net.js';

// 先读本机 .env（可选），再读配置：这样 `pnpm dev:api` 不带前缀也能拿到 .env 里的 PORT。
loadEnvFileIfPresent();

const config = loadConfig();
const db = openDatabase(config.dbPath);

const applied = runMigrations(db, config.migrationsDir);
if (applied.length > 0) {
  console.log(`已应用迁移: ${applied.join(', ')}`);
}

const server = serve(
  /**
   * hostname 必须显式传：不传时 Node 绑的是 `::`（全部网卡），日志却写着 localhost，
   * 于是一个「个人本机应用」默认对同网段敞开（见 docs/audit-2026-09-23.md 的 A1）。
   * 现在默认 `127.0.0.1`，跨设备访问要自己设 HOST（见 docs/decisions.md D55）。
   */
  { fetch: createApp(db, { host: config.host }).fetch, port: config.port, hostname: config.host },
  (info) => {
    console.log(`API 监听 http://${formatHost(config.host)}:${info.port}`);
    if (!isLoopbackHostName(hostNameOf(config.host))) {
      console.warn(
        `注意：HOST=${config.host} 让 API 监听非本机地址，而接口没有鉴权——` +
          '同网段（含 Tailscale）的设备可以读写全部任务。只在本机用请删掉 HOST。',
      );
    }
    console.log(`数据库: ${config.dbPath}`);
  },
);

/** IPv6 地址要加方括号才是一个能点开的 URL。 */
function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

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
