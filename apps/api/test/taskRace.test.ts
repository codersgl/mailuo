import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import * as tasksRepo from '../src/repositories/tasks.js';
import { createTestDb, insertTask } from './helpers.js';

/**
 * `requireTask` 的竞态兜底。
 *
 * 路由的写法是「先查存在性（404）→ 再调仓储写入 → 拿到 undefined 说明校验通过后任务却不见了」。
 * 单线程的用例走不到这条竞态，但代码里把它写成了显式断言，并且在注释里说明了意图：真触发时
 * 必须 **500 加日志**，而不是假装 404（会骗客户端「没有这个任务」）或静默成功（写事务可能
 * 已经提交，客户端重试就可能重复写入）。
 *
 * 所以这里用一次受控的模块替身强制触发：只把 `applyTaskUpdate` 换成一个可编程的包装，
 * 其余导出保持真实实现；`mockReturnValueOnce(undefined)` 之后仍然回落到真函数。
 * `vi.mock` 是文件级的，不会影响别的测试文件。
 */
vi.mock('../src/repositories/tasks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof tasksRepo>();
  return { ...actual, applyTaskUpdate: vi.fn(actual.applyTaskUpdate) };
});

afterEach(() => {
  // 用例中途断言失败时也要还原：否则 console.error 会一直被挡着、applyTaskUpdate 上排队的
  // mockReturnValueOnce 也会留给下一条用例（这个文件现在只有一条，但加第二条就会踩）。
  vi.restoreAllMocks();
});

describe('requireTask 的竞态兜底', () => {
  it('校验通过后任务查不到：500 加日志，而不是 404 或静默成功', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(tasksRepo.applyTaskUpdate).mockReturnValueOnce(undefined);

    const response = await createApp(db).request(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'B' }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '服务器内部错误' });
    // 日志是这条契约的一半：静默的 500 在生产里查不出原因。
    // 断言的是**那条**错误而不是「发生过 console.error」——路由后面若因为 undefined 再抛
    // TypeError，同样会打日志、同样回 500，只数次数会让「守卫被删掉」这种变异活下来。
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]?.[0])).toContain('前置校验通过后任务却查不到');
  });
});
