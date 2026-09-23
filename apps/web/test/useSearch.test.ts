import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchResponse, SearchResult } from '../src/api/types';
import { useSearch } from '../src/hooks/useSearch';

/**
 * useSearch 的接线测试：防抖、空词不发请求、旧结果先留着、晚到的响应被丢弃。
 * 用真实的 200ms 防抖（不装假定时器）：测试里最直接的证据就是「渲染完立刻看，请求还没发」。
 */

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

/** 等到 fetch 被调用第 n 次（防抖窗口过去之后才会有第一次）。 */
async function waitForRequests(count: number): Promise<void> {
  await waitFor(() => expect(pending).toHaveLength(count));
}

function result(id: string, title: string): SearchResult {
  return {
    id,
    title,
    snippet: null,
    columnId: 'todo',
    durationMinutes: null,
    archivedAt: null,
    path: [],
  };
}

const COLUMNS = [{ id: 'todo', name: '待办', orders: 1000 }];

function response(results: SearchResult[], truncated = false): SearchResponse {
  return { columns: COLUMNS, results, truncated };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSearch', () => {
  it('关键词为空时停在 idle，一个请求都不发', async () => {
    stubDeferredFetch();
    const { result: hook } = renderHook(() => useSearch('   ', false));

    expect(hook.current.state.status).toBe('idle');
    // 超过防抖窗口也不该发请求。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pending).toHaveLength(0);
  });

  it('输入后不立刻发请求，过了防抖窗口才发，并把搜索词与开关带上', async () => {
    stubDeferredFetch();
    renderHook(() => useSearch('登录', true));

    expect(pending).toHaveLength(0);

    await waitForRequests(1);
    expect(pending[0]?.url).toBe('/api/search?q=%E7%99%BB%E5%BD%95&includeArchived=1');

    pending[0]?.respond(response([result('t1', '登录页')]));
  });

  it('拿到结果后进入 ready，并带出 truncated', async () => {
    stubDeferredFetch();
    const { result: hook } = renderHook(() => useSearch('登录', false));

    await waitForRequests(1);
    pending[0]?.respond(response([result('t1', '登录页')], true));

    await waitFor(() => expect(hook.current.state.status).toBe('ready'));
    expect(hook.current.state).toMatchObject({
      // keyword 必须跟着结果一起记下来：输入框可能已经又变了，界面靠它判断这批结果属于谁。
      keyword: '登录',
      results: [{ id: 't1', title: '登录页' }],
      truncated: true,
    });
  });

  it('防抖窗口内继续输入会取消上一次请求：只发一次，用最后那个词', async () => {
    stubDeferredFetch();
    const { result: hook, rerender } = renderHook(({ keyword }) => useSearch(keyword, false), {
      initialProps: { keyword: '甲' },
    });

    // 还没到 200ms 就改成「甲乙」：上一次的定时器必须被清掉，否则会多出一个 q=甲 的请求。
    rerender({ keyword: '甲乙' });
    await waitForRequests(1);

    expect(pending).toHaveLength(1);
    expect(new URLSearchParams(pending[0]?.url.split('?')[1]).get('q')).toBe('甲乙');

    pending[0]?.respond(response([result('t1', '甲乙任务')]));
    await waitFor(() =>
      expect(hook.current.state).toMatchObject({ status: 'ready', keyword: '甲乙' }),
    );
  });

  it('继续输入时保留上一批结果，不退回 loading', async () => {
    stubDeferredFetch();
    const { result: hook, rerender } = renderHook(({ keyword }) => useSearch(keyword, false), {
      initialProps: { keyword: '登' },
    });

    await waitForRequests(1);
    pending[0]?.respond(response([result('t1', '登录页')]));
    await waitFor(() => expect(hook.current.state.status).toBe('ready'));

    rerender({ keyword: '登录' });

    // 新请求还没发出去（防抖窗口内），旧结果仍在，且状态没有变回 loading。
    expect(pending).toHaveLength(1);
    expect(hook.current.state).toMatchObject({ status: 'ready', results: [{ id: 't1' }] });

    await waitForRequests(2);
    pending[1]?.respond(response([result('t2', '登录接口')]));
    await waitFor(() =>
      expect(hook.current.state).toMatchObject({ status: 'ready', results: [{ id: 't2' }] }),
    );
  });

  it('清空关键词立刻回到 idle，并丢掉旧结果', async () => {
    stubDeferredFetch();
    const { result: hook, rerender } = renderHook(({ keyword }) => useSearch(keyword, false), {
      initialProps: { keyword: '登录' },
    });

    await waitForRequests(1);
    pending[0]?.respond(response([result('t1', '登录页')]));
    await waitFor(() => expect(hook.current.state.status).toBe('ready'));

    rerender({ keyword: '' });

    expect(hook.current.state).toEqual({ status: 'idle' });
  });

  it('失败时带出后端文案，retry 会重新取一次', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: '搜索词最多 100 字' }), { status: 400 }),
    );
    const { result: hook } = renderHook(() => useSearch('登录', false));

    await waitFor(() => expect(hook.current.state.status).toBe('failed'));
    expect(hook.current.state).toMatchObject({ message: '搜索词最多 100 字' });

    stubDeferredFetch();
    hook.current.retry();

    await waitForRequests(1);
    pending[0]?.respond(response([result('t1', '登录页')]));
    await waitFor(() => expect(hook.current.state.status).toBe('ready'));
  });

  it('关键词变化后，晚到的旧请求结果被丢弃', async () => {
    stubDeferredFetch();
    const { result: hook, rerender } = renderHook(({ keyword }) => useSearch(keyword, false), {
      initialProps: { keyword: '登' },
    });

    await waitForRequests(1);
    rerender({ keyword: '登录' });
    await waitForRequests(2);

    // 后发起的先回来，先发起的后回来。
    pending[1]?.respond(response([result('t2', '登录接口')]));
    await waitFor(() =>
      expect(hook.current.state).toMatchObject({ status: 'ready', results: [{ id: 't2' }] }),
    );

    pending[0]?.respond(response([result('t1', '登录页')]));
    // 等旧请求的 then 回调真的跑完，否则「晚到的结果被丢弃」可能因为还没执行而假通过。
    await act(async () => {});

    expect(hook.current.state).toMatchObject({ results: [{ id: 't2' }] });
  });
});
