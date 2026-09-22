import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROOT_BOARD_TITLE, useBreadcrumb } from '../src/hooks/useBreadcrumb';

/** 根看板没有任务 id 可查，所以这一段不发请求；任务看板的面包屑一律由后端回溯。 */

let requested: string[] = [];

function stubFetch(body: unknown, status = 200): void {
  requested = [];
  vi.stubGlobal('fetch', (input: string) => {
    requested.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useBreadcrumb', () => {
  it('根看板直接用常量，同步就是 ready 且不发请求', () => {
    stubFetch({ items: [] });
    const { result } = renderHook(() => useBreadcrumb(null));

    // 同步断言：根看板那一段不经过请求，顶栏不会先闪一帧空白。
    expect(result.current.state).toEqual({
      status: 'ready',
      data: [{ id: null, title: ROOT_BOARD_TITLE }],
    });
    expect(requested).toEqual([]);
  });

  it('任务看板读 /api/breadcrumb/:taskId', async () => {
    const items = [
      { id: null, title: ROOT_BOARD_TITLE },
      { id: 'p', title: '重构登录' },
      { id: 'c', title: '前端部分' },
    ];
    stubFetch({ items });
    const { result } = renderHook(() => useBreadcrumb('c'));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(requested).toEqual(['/api/breadcrumb/c']);
    expect(result.current.state).toEqual({ status: 'ready', data: items });
  });

  it('任务不存在时显示后端文案', async () => {
    stubFetch({ error: '任务不存在' }, 404);
    const { result } = renderHook(() => useBreadcrumb('missing'));

    await waitFor(() =>
      expect(result.current.state).toEqual({ status: 'failed', message: '任务不存在' }),
    );
  });
});
