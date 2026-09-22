import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBoard } from '../src/hooks/useBoard';
import type { Board } from '../src/api/types';

/**
 * useBoard 是 useAsync 在「看板」这一个读取上的接线，用真实的 React 挂载来测（jsdom）：
 * 覆盖三种状态、竞态、重试，并钉住「URL 决定请求哪一层看板」这条最关键的接线。
 *
 * 这里没有「卸载后不再写状态」的用例：React 19 会静默忽略已卸载组件的 setState，
 * 删掉守卫也观测不到差别，写了等于空断言。晚到的失败不覆盖新数据由 useAsync.test.ts 覆盖。
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
  it('根看板请求 /api/board，拿到看板后进入 ready', async () => {
    stubDeferredFetch();
    const { result } = renderHook(() => useBoard(null, false));

    expect(result.current.state.status).toBe('loading');

    await waitForRequests(1);
    expect(pending[0]?.url).toBe('/api/board');
    pending[0]?.respond(board(null));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toMatchObject({ data: { parentId: null } });
  });

  it('任务看板请求 /api/board/:taskId（URL 决定看哪一层）', async () => {
    stubDeferredFetch();
    const { result } = renderHook(() => useBoard('t1', false));

    await waitForRequests(1);
    expect(pending[0]?.url).toBe('/api/board/t1');
    pending[0]?.respond(board('t1'));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toMatchObject({ data: { parentId: 't1' } });
  });

  it('「显示已归档」打开时把 includeArchived 带给后端', async () => {
    stubDeferredFetch();
    const { result } = renderHook(() => useBoard(null, true));

    await waitForRequests(1);
    expect(pending[0]?.url).toBe('/api/board?includeArchived=1');

    pending[0]?.respond(board(null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
  });

  it('开关切换属于「换了一份数据」：会回到 loading，而不是沿用旧列表', async () => {
    stubDeferredFetch();
    const { result, rerender } = renderHook(
      ({ includeArchived }) => useBoard(null, includeArchived),
      { initialProps: { includeArchived: false } },
    );

    await waitForRequests(1);
    pending[0]?.respond(board(null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    rerender({ includeArchived: true });
    expect(result.current.state.status).toBe('loading');

    await waitForRequests(2);
    expect(pending[1]?.url).toBe('/api/board?includeArchived=1');
    pending[1]?.respond(board(null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
  });

  it('把 ApiError 的中文文案带进 failed 状态', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: '任务不存在' }), { status: 404 }),
    );
    const { result } = renderHook(() => useBoard('missing', false));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toMatchObject({ message: '任务不存在' });
  });

  it('非 ApiError 的失败给兜底文案', async () => {
    stubRejectingFetch(new TypeError('boom'));
    const { result } = renderHook(() => useBoard(null, false));

    // fetch 抛错在 client 里已经转成 ApiError(0)，这里断言它不会漏成原始异常。
    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toMatchObject({
      message: '连不上后端，确认 `pnpm dev:api` 已经启动',
    });
  });

  it('parentId 变化时旧请求的结果被丢弃', async () => {
    stubDeferredFetch();
    const { result, rerender } = renderHook(({ parentId }) => useBoard(parentId, false), {
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
    // 等旧请求的 then 回调真的跑完，否则「晚到的结果被丢弃」可能因为还没执行而假通过。
    await act(async () => {});

    expect(result.current.state).toMatchObject({ data: { parentId: 'b' } });
  });

  it('reload 会重新取一次', async () => {
    stubDeferredFetch();
    const { result, rerender } = renderHook(() => useBoard(null, false));

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
