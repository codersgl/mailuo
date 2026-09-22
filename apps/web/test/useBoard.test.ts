import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBoard } from '../src/hooks/useBoard';
import type { Board } from '../src/api/types';

/**
 * useBoard 是本步唯一的异步/竞态逻辑，所以用真实的 React 挂载来测（jsdom 环境）。
 * 关键用例是「晚回来的旧请求不能覆盖新看板」：删掉 hook 里的 cancelled 守卫必须让它失败。
 */

/** 手工控制每次请求何时返回，用来制造乱序。 */
interface PendingRequest {
  url: string;
  respond: (body: unknown, status?: number) => void;
}

let pending: PendingRequest[] = [];

function stubDeferredFetch(): void {
  pending = [];
  vi.stubGlobal('fetch', (input: string) => {
    return new Promise<Response>((resolve) => {
      pending.push({
        url: String(input),
        respond: (body, status = 200) =>
          resolve(
            new Response(JSON.stringify(body), {
              status,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
      });
    });
  });
}

function stubRejectingFetch(cause: unknown): void {
  vi.stubGlobal('fetch', () => Promise.reject(cause));
}

function board(parentId: string | null): Board {
  return { parentId, columns: [] };
}

/** 等到 fetch 被调用第 n 次。 */
async function waitForRequests(count: number): Promise<void> {
  await waitFor(() => expect(pending).toHaveLength(count));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useBoard', () => {
  it('先返回加载中，拿到看板后进入 ready', async () => {
    stubDeferredFetch();
    const { result } = renderHook(() => useBoard(null));

    expect(result.current.state.status).toBe('loading');

    await waitForRequests(1);
    expect(pending[0]?.url).toBe('/api/board');
    pending[0]?.respond(board(null));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toMatchObject({ board: { parentId: null } });
  });

  it('把 ApiError 的中文文案带进 failed 状态', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: '任务不存在' }), { status: 404 }),
    );
    const { result } = renderHook(() => useBoard('missing'));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toMatchObject({ message: '任务不存在' });
  });

  it('非 ApiError 的失败给兜底文案', async () => {
    stubRejectingFetch(new TypeError('boom'));
    const { result } = renderHook(() => useBoard(null));

    // fetch 抛错在 client 里已经转成 ApiError(0)，这里断言它不会漏成原始异常。
    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toMatchObject({ message: '连不上后端，确认 `pnpm dev:api` 已经启动' });
  });

  it('parentId 变化时旧请求的结果被丢弃', async () => {
    stubDeferredFetch();
    const { result, rerender } = renderHook(({ parentId }) => useBoard(parentId), {
      initialProps: { parentId: 'a' as string | null },
    });

    await waitForRequests(1);
    rerender({ parentId: 'b' });
    await waitForRequests(2);
    expect(pending[1]?.url).toBe('/api/board/b');

    // 后发起的先回来，先发起的后回来：晚到的 'a' 必须被忽略。
    pending[1]?.respond(board('b'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    pending[0]?.respond(board('a'));
    await waitFor(() => expect(pending).toHaveLength(2));

    expect(result.current.state).toMatchObject({ board: { parentId: 'b' } });
  });

  it('卸载后返回的响应不再写状态', async () => {
    stubDeferredFetch();
    const { unmount } = renderHook(() => useBoard(null));

    await waitForRequests(1);
    unmount();
    // 卸载后响应才回来，这里不抛异常、也没有状态更新警告即为通过。
    pending[0]?.respond(board(null));
    await Promise.resolve();
  });

  it('reload 会重新取一次', async () => {
    stubDeferredFetch();
    const { result, rerender } = renderHook(() => useBoard(null));

    await waitForRequests(1);
    pending[0]?.respond(board(null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    result.current.reload();
    await waitForRequests(2);

    pending[1]?.respond(board(null));
    rerender();
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
  });
});
