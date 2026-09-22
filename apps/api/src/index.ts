import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig, loadEnvFileIfPresent } from './config.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';

// 先读本机 .env（可选），再读配置：这样 `pnpm dev:api` 不带前缀也能拿到 .env 里的 PORT。
loadEnvFileIfPresent();

const config = loadConfig();
const db = openDatabase(config.dbPath);

const applied = runMigrations(db, config.migrationsDir);
if (applied.length > 0) {
  console.log(`已应用迁移: ${applied.join(', ')}`);
}

const server = serve({ fetch: createApp(db).fetch, port: config.port }, (info) => {
  console.log(`API 监听 http://localhost:${info.port}`);
  console.log(`数据库: ${config.dbPath}`);
});

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
