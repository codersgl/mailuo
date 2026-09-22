import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';

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
    console.error(
      `端口 ${config.port} 已被占用。换一个端口启动，例如：PORT=${config.port + 1} pnpm dev:api`,
    );
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
