import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTree } from '../src/hooks/useTree';
import type { TreeTask } from '../src/api/types';

/** 任务树是否带归档由后端的查询参数决定，所以这里断言的是真实的请求 URL，而不是本地过滤结果。 */

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

const task: TreeTask = {
  id: 'a',
  parentId: null,
  title: '任务 A',
  columnId: 'todo',
  archivedAt: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useTree', () => {
  it('默认不带归档参数，并把 tasks 解出来', async () => {
    stubFetch({ tasks: [task] });
    const { result } = renderHook(() => useTree(false));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(requested).toEqual(['/api/tree']);
    expect(result.current.state).toEqual({ status: 'ready', data: [task] });
  });

  it('打开「显示已归档」时带 ?includeArchived=1 并重取', async () => {
    stubFetch({ tasks: [task] });
    const { result, rerender } = renderHook(({ show }) => useTree(show), {
      initialProps: { show: false },
    });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    rerender({ show: true });

    await waitFor(() =>
      expect(requested).toEqual(['/api/tree', '/api/tree?includeArchived=1']),
    );
  });

  it('失败时带出后端的中文文案', async () => {
    stubFetch({ error: '服务挂了' }, 500);
    const { result } = renderHook(() => useTree(false));

    await waitFor(() =>
      expect(result.current.state).toEqual({ status: 'failed', message: '服务挂了' }),
    );
  });
});
