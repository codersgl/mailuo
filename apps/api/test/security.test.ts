import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb } from './helpers.js';

/**
 * Host / Origin 白名单与请求体上限的接口级用例。
 *
 * 这些行为必须在「应用是被怎么组装起来的」这一层测：domain/net.ts 的纯函数已经单独测过，
 * 但真正挡住请求的是 app.ts 里中间件的注册顺序（Host 校验必须在路由之前、读接口也要过）。
 */

/** 用绝对 URL 造请求：Host 头由 URL 的主机名决定，正好是要测的东西。 */
function health(app: ReturnType<typeof createApp>, host: string): Promise<Response> {
  return app.request(`http://${host}/api/health`);
}

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

  it('HOST 设成具体地址时那个地址放行，别的还是拒', async () => {
    const app = createApp(createTestDb(), { host: '10.32.213.214' });

    expect((await health(app, '10.32.213.214:3003')).status).toBe(200);
    expect((await health(app, '127.0.0.1:3003')).status).toBe(200);
    expect((await health(app, 'evil.example')).status).toBe(403);
  });

  it('HOST 是通配地址时不再限制 Host（用户显式放开）', async () => {
    const app = createApp(createTestDb(), { host: '0.0.0.0' });

    expect((await health(app, 'evil.example')).status).toBe(200);
  });
});

describe('Origin 校验（写请求）', () => {
  const createBody = JSON.stringify({ columnId: 'todo', title: '从别的页面发来的' });

  it('不带 Origin 的写请求放行（curl、同源表单）', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createBody,
    });

    expect(response.status).toBe(201);
  });

  it('同源 Origin 放行（开发态 Vite 代理）', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: createBody,
    });

    expect(response.status).toBe(201);
  });

  it('别的站的 Origin 被拒', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: createBody,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Origin 不允许' });
  });

  it('Origin: null 被拒', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null' },
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 'todo', title: '正常任务' }),
    });

    expect(response.status).toBe(201);
  });
});
