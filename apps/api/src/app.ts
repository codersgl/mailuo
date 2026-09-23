import { serveStatic } from '@hono/node-server/serve-static';
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

/**
 * 静态资源的缓存策略，分两档。
 *
 * Vite 产物的文件名带内容哈希（`assets/index-CxZBCxL2.js`），内容一变文件名就变，所以可以长期缓存；
 * `index.html` 反过来绝不能缓存：升级后浏览器若拿旧 HTML 去请求已经被删掉的旧哈希文件，
 * 页面直接白屏，而且要用户手动强刷才能恢复。判定只看请求路径前缀，不碰文件系统路径
 * ——Windows 上 `path.sep` 是 `\`，按路径判断会漏。
 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

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
  /**
   * 前端构建产物目录（`apps/web/dist`），用于生产时由同一个进程托管页面。
   *
   * 只在产物确实存在时才传（判定在 `index.ts`）：开发态前端由 Vite 提供，传一个不存在的目录
   * 只会让 serveStatic 打一行英文告警。不传时本应用纯 API，行为与以前完全一致。
   */
  staticRoot?: string;
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

  /**
   * 生产：同一个进程顺手托管前端产物（见 docs/spec.md 的「生产」一条）。
   *
   * 注册在 API 路由**之后**：匹配到的接口在前面就返回了，静态 handler 根本不会被调用。这只是省掉
   * 两道无用的 handler——保证「静态文件盖不住接口、`/api/*` 的 404 一定是 JSON」的是下面 `isApiPath`
   * 那层守卫（把整块挪到路由之前，用例照样全绿；去掉守卫才会红）。
   *
   * 逻辑三段：
   * 1. 先补 `Cache-Control`（只对非 `/api` 路径）；
   * 2. 真文件（`/assets/*`、`favicon` 之类），命中即返回；
   * 3. 其余非 `/api` 的路径一律回 `index.html`，交给前端路由自己解析
   *    ——路由是手写的 `/` 与 `/board/:taskId`，刷新时服务器上并没有对应的文件。
   *
   * 不做按 `Accept` 头区分「浏览器导航」与「资源请求」的细化：未知路径一律回页面。代价是拼错的
   * 资源路径也会拿到 200 的 HTML（由前端路由画「未找到」），换来的是判定只有一条规则。
   */
  if (options.staticRoot !== undefined) {
    const root = options.staticRoot;
    /**
     * 缓存头必须在 serveStatic 之前设。它只在文件命中后才回调 `onFound`，而那时 Response 已经
     * 建好了，`c.header()` 改的是 `#preparedHeaders`，Response 里的头部是构造时复制的一份，
     * 改不到（实测：写在 onFound 里，响应上没有这个头）。
     *
     * 判定放在这里而不是只放在 SPA 回退里：`/` 与 `/board/` 这种目录路径会被 serveStatic 自己
     * 解析成 `index.html`，根本不经过回退——只给回退加头会漏掉最需要 `no-cache` 的那一个。
     */
    app.use('*', async (c, next) => {
      if (!isApiPath(c.req.path)) {
        const cache = c.req.path.startsWith('/assets/') ? IMMUTABLE_CACHE : NO_CACHE;
        c.header('Cache-Control', cache);
      }
      await next();
    });
    const files = serveStatic({ root });
    const indexHtml = serveStatic({ root, path: 'index.html' });
    /**
     * `/api/*` 是接口的保留命名空间，两道静态 handler 都套同一层守卫：
     * 既不去 dist 里找同名文件（万一 dist 里真有个 `api/xxx`，接口的 404 就变成那个文件了），
     * 也不回退成 HTML。没有这层守卫时，「接口的 404 一定是 JSON」只是碰巧成立。
     */
    const serveFile = async (c: Context, next: () => Promise<void>) => {
      if (isApiPath(c.req.path)) return next();
      return files(c, next);
    };
    /**
     * 回退发的一定是 `index.html`，所以这里把缓存头改回 `no-cache`：上面那层按请求路径判定，
     * `/assets/` 下不存在的文件也会走到回退，不该带着 `immutable` 回来。
     */
    const spaFallback = async (c: Context, next: () => Promise<void>) => {
      if (isApiPath(c.req.path)) return next();
      c.header('Cache-Control', NO_CACHE);
      return indexHtml(c, next);
    };
    /**
     * 不注册 HEAD：Hono 自己把 HEAD 转成 GET 处理（`hono-base` 的 `#dispatch` 对 HEAD 直接
     * 递归一次 GET 再用 `new Response(null, ...)` 丢掉 body），所以这里写 `HEAD` 是死代码。
     */
    app.on('GET', '*', serveFile);
    app.on('GET', '*', spaFallback);
  }

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
 * 请求路径是否落在接口命名空间里。
 *
 * SPA 回落要靠它把 `/api/*` 排除掉：接口的 404 必须是 `{ error: string }`，
 * 不能因为「dist 里没有 `api/xxx` 这个文件」就回一张 HTML 页面。
 * 判定写成两段而不是 `startsWith('/api')`：`/apiary` 不是接口路径。
 */
function isApiPath(requestPath: string): boolean {
  return requestPath === '/api' || requestPath.startsWith('/api/');
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
