import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { Db } from './db/client.js';
import type { HostAllowOptions } from './domain/net.js';
import { DEFAULT_HOST, isAllowedHostHeader, isAllowedOrigin } from './domain/net.js';
import { createBoardRoutes } from './routes/board.js';
import { createTaskRoutes } from './routes/tasks.js';

/**
 * 请求体上限 256KB。
 *
 * 为什么要设：zValidator 会把整个 body 读进内存再解析（`c.req.json()`），没有上限时一条
 * 几百 MB 的 JSON 就能让进程 OOM（见 docs/audit-2026-09-23.md 的 A3）。接口本身的入参形状很小
 * ——描述上限 10000 字、标题 200 字——256KB 有两个数量级的余量，正常请求碰不到。
 */
const MAX_BODY_BYTES = 256 * 1024;

export interface AppOptions {
  /**
   * API 实际监听的地址，决定 Host 白名单。默认 `127.0.0.1`（只服务本机）。
   * 生产入口把它接上 `config.host`，测试里不传即用默认值。
   */
  host?: string;
  /**
   * 额外放行的 Host 主机名。跨设备访问时由启动方填：本机网卡地址 + `HOST_ALLOW`。
   * 不填时通配监听只放行回环主机名——**不能**改成「通配就一律放行」，
   * 那会让 DNS rebinding 那道锁跟着一起消失（见 docs/decisions.md D55）。
   */
  allowedHosts?: readonly string[];
}

/**
 * 组装 Hono 应用。数据库句柄由调用方注入，测试里换成内存库即可，不需要起进程。
 */
export function createApp(db: Db, options: AppOptions = {}): Hono {
  const hostOptions: HostAllowOptions = {
    listenHost: options.host ?? DEFAULT_HOST,
    allowedHosts: options.allowedHosts,
  };
  const app = new Hono();

  /**
   * Host 白名单：挡 DNS rebinding。
   *
   * 具体追踪：没有鉴权时，恶意页面只要让自己的域名重绑定到 127.0.0.1，浏览器就认为它与 API
   * 同源，于是既能读走全部任务，也能发 `Content-Type: application/json` 的写请求（那本来是用来
   * 挡跨站表单的）。这类请求的 Host 是攻击者的域名，所以在这里被拒。判定规则见 domain/net.ts。
   *
   * 放在所有路由之前，读接口也过一遍——rebinding 的目的是读，只拦写等于没拦。
   */
  app.use('*', async (c, next) => {
    const hostHeader = requestHost(c);
    if (!isAllowedHostHeader(hostHeader, hostOptions)) {
      return c.json({ error: 'Host 不在允许列表内' }, 403);
    }
    /**
     * 写请求再看 Origin：缺失（curl、同源表单）或落在同一份白名单里才放行。
     * 这是 Host 校验之外的第二道锁——Host 头可以被非浏览器客户端随意伪造，
     * 但浏览器一定会带上真实的 Origin，所以它挡的是「用户浏览器里的别的页面」。
     */
    const method = c.req.method;
    const origin = c.req.header('origin');
    if (origin !== undefined && method !== 'GET' && method !== 'HEAD') {
      if (!isAllowedOrigin(origin, hostOptions)) {
        return c.json({ error: 'Origin 不允许' }, 403);
      }
    }
    await next();
  });

  // 读 body 之前先卡大小，别等 zValidator 把它整个读进内存。
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: '请求体过大' }, 413),
    }),
  );

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
 * 本次请求的 Host：优先取 Host 头，取不到时退回请求 URL 的主机名。
 *
 * 为什么需要那个兜底：Hono 的 `app.request('/path')` **不会**自动加 Host 头（单测全走这条路），
 * 而 `@hono/node-server` 在生产里正是用 Host 头拼出 `request.url` 的
 * （`server.mjs`：`new URL(\`${scheme}://${host}${incomingUrl}\`)`），所以 URL 里的主机名
 * 与真实 Host 一致，可以当兜底。用真实 Host 头优先的好处是它与适配器看到的是同一个值。
 *
 * 顺带说明一个容易搞错的点：Host 虽然是 fetch 规范里的 forbidden header，但那道过滤只在
 * `fetch()` 上；`new Request(url, { headers: { Host } })` 是保留它的，所以测试里可以显式传
 * Host 来覆盖生产路径。
 */
function requestHost(c: Context): string {
  const header = c.req.header('host');
  if (header !== undefined && header !== '') return header;
  try {
    return new URL(c.req.url).host;
  } catch {
    return '';
  }
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
