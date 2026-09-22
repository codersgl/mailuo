import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Db } from './db/client.js';
import { createBoardRoutes } from './routes/board.js';
import { createTaskRoutes } from './routes/tasks.js';

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

  app.route('/', createBoardRoutes(db));
  app.route('/', createTaskRoutes(db));

  // 错误统一返回 { error: string }（见 docs/spec.md）。
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((error, c) => {
    // HTTPException 携带有意义的状态码（例如后续 zValidator 校验失败抛的 400），
    // 直接放行它的响应，不要压成 500。
    if (error instanceof HTTPException) {
      return toErrorResponse(error, c);
    }
    console.error(error);
    return c.json({ error: 'internal server error' }, 500);
  });

  return app;
}

/**
 * Hono 在请求体不是合法 JSON 时抛的 HTTPException 自带 text/plain 纯文本响应，
 * 而规范要求所有错误都是 `{ error: string }`，这里统一包一层 JSON。
 * HTTPException 报错文案里唯一需要翻译的是 Hono 自己的 JSON 解析失败提示。
 */
function toErrorResponse(error: HTTPException, c: Context): Response {
  const response = error.getResponse();
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    return response;
  }
  const message =
    error.message === 'Malformed JSON in request body' ? '请求体不是合法 JSON' : error.message;
  return c.json({ error: message || '请求失败' }, error.status);
}
