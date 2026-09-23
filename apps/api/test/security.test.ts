import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb } from './helpers.js';

/**
 * Host / Origin 白名单与请求体上限的接口级用例。
 *
 * 这些行为必须在「应用是被怎么组装起来的」这一层测：domain/net.ts 的纯函数已经单独测过，
 * 但真正挡住请求的是 app.ts 里中间件的注册顺序（Host 校验必须在路由之前、读接口也要过）。
 */

/** 用绝对 URL 造请求：Host 头由 URL 的主机名决定。 */
function health(app: ReturnType<typeof createApp>, host: string): Promise<Response> {
  return app.request(`http://${host}/api/health`);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('Host 白名单（默认只服务本机）', () => {
  it('回环主机名放行', async () => {
    const app = createApp(createTestDb());

    expect((await health(app, '127.0.0.1:3003')).status).toBe(200);
    expect((await health(app, 'localhost:3003')).status).toBe(200);
  });

  it('外部域名的请求被拒，读接口也一样', async () => {
    const app = createApp(createTestDb());

    const response = await health(app, 'evil.example');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Host 不在允许列表内' });
  });

  it('伪装成回环的域名被拒（DNS rebinding 的入口）', async () => {
    const app = createApp(createTestDb());

    expect((await health(app, '127.0.0.1.evil.example')).status).toBe(403);
  });

  it('显式带 Host 头时以它为准（生产走的就是这条路径）', async () => {
    const app = createApp(createTestDb());

    // URL 是回环，但头被伪造：必须以头为准拒绝。Hono 的 app.request 不带 Host 头时
    // 会退回 URL 主机名（见 app.ts 的 requestHost），所以这条用例专门覆盖「头存在」的分支。
    const response = await app.request('http://127.0.0.1:3003/api/health', {
      headers: { Host: 'evil.example' },
    });

    expect(response.status).toBe(403);
  });

  it('HOST 设成具体地址时那个地址放行，别的还是拒', async () => {
    const app = createApp(createTestDb(), { host: '10.32.213.214' });

    expect((await health(app, '10.32.213.214:3003')).status).toBe(200);
    expect((await health(app, '127.0.0.1:3003')).status).toBe(200);
    expect((await health(app, 'evil.example')).status).toBe(403);
  });

  it('通配监听只放行枚举到的本机地址，不是一律放行', async () => {
    const app = createApp(createTestDb(), {
      host: '0.0.0.0',
      allowedHosts: ['10.32.213.214', 'kanban.local'],
    });

    expect((await health(app, '10.32.213.214:3003')).status).toBe(200);
    expect((await health(app, 'kanban.local:3003')).status).toBe(200);
    expect((await health(app, '127.0.0.1:3003')).status).toBe(200);
    // 这条是这次审阅指出的缺口：原来「通配就一律放行」，等于把 rebinding 那道锁一起关了。
    expect((await health(app, 'evil.example')).status).toBe(403);
  });
});

describe('Origin 校验（写请求）', () => {
  const createBody = JSON.stringify({ columnId: 'todo', title: '从别的页面发来的' });

  it('不带 Origin 的写请求放行（curl、同源表单）', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: createBody,
    });

    expect(response.status).toBe(201);
  });

  it('开发态经 Vite 代理的写请求放行（Host 是 127.0.0.1，Origin 是 localhost）', async () => {
    const app = createApp(createTestDb());

    // 这是 changeOrigin: true 之后的真实组合：两者主机名不同，靠「回环」这条规则放行。
    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { ...JSON_HEADERS, Host: '127.0.0.1:3003', Origin: 'http://localhost:5173' },
      body: createBody,
    });

    expect(response.status).toBe(201);
  });

  it('别的站的 Origin 被拒', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { ...JSON_HEADERS, Origin: 'http://evil.example' },
      body: createBody,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Origin 不允许' });
  });

  it('每个写方法（POST / PATCH / PUT / DELETE）都过 Origin 校验', async () => {
    const app = createApp(createTestDb());
    const evil = { ...JSON_HEADERS, Origin: 'http://evil.example' };

    const responses = await Promise.all([
      app.request('/api/tasks', { method: 'POST', headers: evil, body: createBody }),
      app.request('/api/tasks/nope', { method: 'PATCH', headers: evil, body: '{"title":"x"}' }),
      app.request('/api/tasks/nope/parent', {
        method: 'PATCH',
        headers: evil,
        body: '{"parentId":null,"columnId":"todo"}',
      }),
      app.request('/api/tasks/nope/deps', {
        method: 'PUT',
        headers: evil,
        body: '{"predecessorIds":[]}',
      }),
      app.request('/api/tasks/nope', { method: 'DELETE', headers: evil }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
  });

  it('白名单里的地址作为 Origin 时放行（跨设备同源写）', async () => {
    const app = createApp(createTestDb(), {
      host: '0.0.0.0',
      allowedHosts: ['10.32.213.214'],
    });

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { ...JSON_HEADERS, Origin: 'http://10.32.213.214:3003' },
      body: createBody,
    });

    expect(response.status).toBe(201);
  });

  it('Origin: null 被拒', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { ...JSON_HEADERS, Origin: 'null' },
      body: createBody,
    });

    expect(response.status).toBe(403);
  });

  it('读请求不看 Origin', async () => {
    const app = createApp(createTestDb());

    // 跨站读由浏览器的 CORS 拦，不在这里拦；Host 校验已经挡住 rebinding 那一类。
    const response = await app.request('http://127.0.0.1:3003/api/health', {
      headers: { Origin: 'http://evil.example' },
    });

    expect(response.status).toBe(200);
  });
});

describe('请求体上限', () => {
  it('超过 256KB 的写请求回 413，且不落库', async () => {
    const db = createTestDb();
    const app = createApp(db);
    const huge = JSON.stringify({ columnId: 'todo', title: 'x'.repeat(300 * 1024) });

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: huge,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: '请求体过大' });
    const count = db.prepare('SELECT COUNT(*) AS total FROM tasks').get() as { total: number };
    expect(count.total).toBe(0);
  });

  it('正常大小的写请求照常通过', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ columnId: 'todo', title: '正常任务' }),
    });

    expect(response.status).toBe(201);
  });
});
