import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { validationHook } from '../src/routes/validation.js';

/**
 * 直接挂一条路由把 hook 当普通函数调用：这样能构造真实 Zod 产生不出来的畸形错误对象，
 * 固定「读不到 issues 时降级」的行为。
 */
function callHook(result: Parameters<typeof validationHook>[0]) {
  const app = new Hono();
  app.get('/hook', (c) => validationHook(result, c) ?? c.json({ ok: true }));
  return app.request('/hook');
}

describe('validationHook', () => {
  it('校验通过时放行', async () => {
    const response = await callHook({ success: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('把第一条 issue 压成「字段名: 说明」', async () => {
    const response = await callHook({
      success: false,
      error: { issues: [{ path: ['title'], message: '标题不能为空' }] },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'title: 标题不能为空' });
  });

  it('没有字段路径时只给说明', async () => {
    const response = await callHook({
      success: false,
      error: { issues: [{ path: [], message: '没有需要修改的字段' }] },
    });

    expect(await response.json()).toEqual({ error: '没有需要修改的字段' });
  });

  it('读不到 issues 时降级为「入参非法」，而不是抛异常变 500', async () => {
    const response = await callHook({ success: false, error: {} });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '入参非法' });
  });
});
