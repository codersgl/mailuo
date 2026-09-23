import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb } from './helpers.js';

/**
 * 生产静态托管的接口级用例（审计报告 B1：规范承诺了 `serveStatic` 托管 `apps/web/dist`，
 * 而代码里没有）。
 *
 * 用真实临时目录而不是 mock：这里要测的正是「文件系统里有什么、请求路径怎么映射过去」，
 * 尤其是带编码的路径穿越（mock 掉 fs 就测不出 serveStatic 的解码与拒绝）。
 * 目录结构照 Vite 产物摆：`index.html` + `assets/<name>-<hash>.js`。
 */

const INDEX_HTML = '<!doctype html><html><body><div id="root">看板外壳</div></body></html>';
const ASSET_JS = 'console.log("asset")';
const SECRET = 'dist 目录之外的私密文件，任何响应里都不该出现';

/** 产物根目录（模拟 `apps/web/dist`）与它上一层的临时目录。 */
let distDir: string;
let outerDir: string;

beforeAll(() => {
  outerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-static-'));
  distDir = path.join(outerDir, 'dist');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(distDir, 'assets', 'index-CxZBCxL2.js'), ASSET_JS);
  // 故意在 dist 里摆 api/ 下的文件：接口命名空间不能被静态层响应。`api/index.html` 还会让
  // `GET /api` 在「只判 startsWith('/api/')」的错误实现下被当成目录返回，所以它是那条用例的靶子。
  fs.mkdirSync(path.join(distDir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'api', 'echo.json'), '{"from":"dist"}');
  fs.writeFileSync(path.join(distDir, 'api', 'index.html'), '<!doctype html><p>dist 里的 api 首页</p>');
  /**
   * 穿越用例的靶子。三个位置各钉一条规则，缺一个断言就是空的（见下面用例的注释）：
   * - `outerDir/secret.txt`：`..` 真的解出来时才会读到；
   * - `outerDir/%2fsecret.txt`：`%2f` 不被 decodeURI 解码，所以请求 `/..%2fsecret.txt`
   *   一旦越过 `..`，`path.join` 落到的就是这个**字面名**的文件；
   * - `dist/..\secret.txt`：反斜杠在 POSIX 上是普通字符（Linux 上读的就是这个文件），
   *   而在 Windows 上是分隔符（`path.win32.join(dist, '/..\\secret.txt')` 会跳到上一层）。
   */
  fs.writeFileSync(path.join(outerDir, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(outerDir, '%2fsecret.txt'), SECRET);
  fs.writeFileSync(path.join(distDir, '..\\secret.txt'), SECRET);
});

afterAll(() => {
  fs.rmSync(outerDir, { recursive: true, force: true });
});

/** 组装一个带静态托管的 app，请求走绝对 URL（Host 为回环，过白名单）。 */
function staticApp() {
  const app = createApp(createTestDb(), { staticRoot: distDir });
  return (requestPath: string, init?: RequestInit) =>
    app.request(`http://127.0.0.1:3003${requestPath}`, init);
}

describe('静态托管：页面与资源', () => {
  it('GET / 返回 index.html，且不允许缓存', async () => {
    const response = await staticApp()('/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    // index.html 必须每次回源：缓存住旧 HTML 会让升级后的浏览器去请求已删除的旧哈希资源。
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('看板外壳');
  });

  it('前端路由刷新回落 index.html（/board/:taskId 在服务器上没有对应文件）', async () => {
    const response = await staticApp()('/board/task-1');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('看板外壳');
  });

  it('带内容哈希的资源可以长期缓存', async () => {
    const response = await staticApp()('/assets/index-CxZBCxL2.js');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe(ASSET_JS);
  });

  it('HEAD / 返回同样的状态码与头部，没有 body', async () => {
    const response = await staticApp()('/', { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe('');
  });

  it('不存在的资源路径走到回退，改回 no-cache（别把 404 页面缓存一年）', async () => {
    const response = await staticApp()('/assets/no-such.js');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('看板外壳');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });
});

describe('静态托管：不能越过的边界', () => {
  it('未匹配的 /api 路径仍是 JSON 404，不回退成 HTML', async () => {
    const response = await staticApp()('/api/不存在');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: '路径不存在' });
  });

  it('/api 与 /api/ 本身也是接口路径，不是页面', async () => {
    // 精确匹配这一半单独钉住：只留 `startsWith('/api/')` 时，`/api` 会落到静态层，
    // 而 dist 里若有 `api/index.html`（用户往 public/api/ 放东西就会出现），它会被当目录返回。
    for (const path of ['/api', '/api/']) {
      const response = await staticApp()(path);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: '路径不存在' });
    }
  });

  it('dist 里 api/ 下的同名文件也不会盖住接口的 404', async () => {
    const response = await staticApp()('/api/echo.json');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '路径不存在' });
  });

  it('接口正常响应不受静态托管影响', async () => {
    const response = await staticApp()('/api/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('/apiary 这类同前缀路径不是接口，照常回落页面', async () => {
    const response = await staticApp()('/apiary');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('看板外壳');
  });

  it('非 GET/HEAD 不会拿到 HTML', async () => {
    const response = await staticApp()('/board/task-1', { method: 'POST' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '路径不存在' });
  });

  it('编码过的 .. 路径穿越读不到 dist 之外的文件', async () => {
    // `%2f` 不让 URL 规范化阶段看出这是两个点（`%2e%2e%2f` 会被原样保留），Hono 的 getPath
    // 把 `%2e` 解成 `.`，所以 serveStatic 看到的是 `/..%2fsecret.txt`：只有它的正则拦住 `..`，
    // 才会去读夹具里那个字面名为 `%2fsecret.txt` 的靶子。
    const response = await staticApp()('/%2e%2e%2fsecret.txt');
    const body = await response.text();

    expect(body).not.toContain(SECRET);
    // 被拒绝之后按普通未知路径处理，也就是回落 index.html。
    expect(response.status).toBe(200);
    expect(body).toContain('看板外壳');
  });

  it('反斜杠形式的穿越同样被拒（Windows 上的唯一防线）', async () => {
    // `/..%5csecret.txt` 解码成 `/..\secret.txt`：POSIX 上 `\` 是普通字符，Windows 上是分隔符。
    // POSIX 侧钉的是「反斜杠不被当分隔符」加上 dist 里那个 `..\secret.txt` 靶子不被读到；
    // Windows 侧靠的是 serveStatic 正则里的 `\\` 分支，这条规则本机没法端到端验证。
    const response = await staticApp()('/..%5csecret.txt');
    const body = await response.text();

    expect(body).not.toContain(SECRET);
    expect(body).toContain('看板外壳');
  });

  it('Host 白名单对页面同样生效（静态资源不是后门）', async () => {
    const app = createApp(createTestDb(), { staticRoot: distDir });

    const response = await app.request('http://evil.example/');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Host 不在允许列表内' });
  });
});

describe('没有前端产物时（开发态）', () => {
  it('不传 staticRoot：/ 回到纯 API 行为，不再有页面', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '路径不存在' });
  });
});
