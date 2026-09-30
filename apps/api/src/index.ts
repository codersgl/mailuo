import { existsSync } from 'node:fs';
import os from 'node:os';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig, loadEnvFileIfPresent } from './config.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { collectLocalAddresses } from './domain/net.js';
import { reconcileDerivedStatus } from './repositories/tasks.js';
import { startServer } from './server.js';
import type { StartupDeps } from './server.js';

/**
 * 服务端入口 = 组合根：把真实实现接给启动流程，然后调用一次。
 *
 * 启动流程本身在 `server.ts`（`startServer(deps)`），那里每一项依赖都能换成替身，有逐项的
 * 用例（`test/server.test.ts`）。逻辑留在本文件就等于留一块没有 vitest 用例的代码——它是顶层
 * 副作用，只能靠 bin 的进程级用例真起服务跑过，重构前长期 0%。
 *
 * 能直接引用函数的地方就直接引用（`loadConfig`、`console.log`、`process.exit`…），只把依赖调用者
 * 的包装成箭头函数（`process.on`、`db.close`）。`console.*` 与 `process.exit` 在 Node 里脱开对象
 * 调用是安全的，直接引用既少一层转发，也让本文件剩下的箭头函数刚好是「只有真起服务才执行」的
 * 那几处接线。
 */
const realDeps: StartupDeps = {
  loadEnvFileIfPresent,
  loadConfig,
  openDatabase,
  runMigrations,
  reconcileDerivedStatus,
  collectLocalAddresses: () => collectLocalAddresses(os.networkInterfaces()),
  fileExists: existsSync,
  createApp,
  // serve 的签名比 ServeLike 宽（多一个可选 listener、句柄类型更具体），结构化兼容，直接赋值
  // 即可——不用 cast，这样 @hono/node-server 改了选项名或句柄形状时 tsc 仍然会报。
  serve,
  now: () => new Date().toISOString(),
  log: console.log,
  warn: console.warn,
  error: console.error,
  closeDatabase: (db) => db.close(),
  exit: process.exit,
  onSignal: (signal, handler) => process.on(signal, handler),
};

startServer(realDeps);
