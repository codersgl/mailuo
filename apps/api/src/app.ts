import { Hono } from 'hono';
import type { Db } from './db/client.js';
import { readBoard } from './repositories/board.js';

/**
 * 组装 Hono 应用。数据库句柄由调用方注入，测试里换成内存库即可，不需要起进程。
 */
export function createApp(db: Db): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => {
    // 真跑一条查询，确认连接可用，而不是只回一个常量。
    db.prepare('SELECT 1').get();
    return c.json({ status: 'ok' });
  });

  // 根看板。子看板 GET /api/board/:parentId 在导航那一步接入，读取逻辑已由 readBoard 支持。
  app.get('/api/board', (c) => c.json(readBoard(db, null)));

  // 错误统一返回 { error: string }（见 docs/spec.md）。
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'internal server error' }, 500);
  });

  return app;
}
