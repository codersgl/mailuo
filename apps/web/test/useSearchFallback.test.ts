import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchSearch } from '../src/api/client';
import { useSearch } from '../src/hooks/useSearch';

/**
 * 「客户端层抛回来的不是 ApiError」时的兜底文案。
 *
 * 为什么单独一个文件：真实走网络时 `request()` 会把所有失败都包成 ApiError（见 api/client.ts），
 * 只有把 `fetchSearch` 换成抛普通 Error 的替身才走得到兜底那一侧；而 `vi.mock` 是文件级的，
 * 塞进 useSearch.test.ts 会顶掉那个文件里「经真实 client 走一遍」的全部用例。
 *
 * 保留真实模块的其余导出（尤其 ApiError 本身）：这样 `cause instanceof ApiError` 比的是同一个
 * 构造器，两个用例的差别只有「客户端层抛出来的到底是什么」。
 */
vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return { ...actual, fetchSearch: vi.fn() };
});

const fetchSearchMock = vi.mocked(fetchSearch);

beforeEach(() => {
  // mockReset 而不是 clearAllMocks：后者只清调用记录，不清 `mockRejectedValueOnce` 的队列，
  // 某条用例漏消费一个 Once 就会漏给下一条。
  fetchSearchMock.mockReset();
});

describe('useSearch 的失败兜底', () => {
  it('非 ApiError 的异常用「搜索失败」兜底，不把原始 message 冒到界面上', async () => {
    fetchSearchMock.mockRejectedValueOnce(new Error('Cannot read properties of undefined'));

    const { result } = renderHook(() => useSearch('登录', false));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toEqual({ status: 'failed', message: '搜索失败' });
  });

  it('ApiError 的中文文案原样带出（兜底只接管非 ApiError）', async () => {
    fetchSearchMock.mockRejectedValueOnce(new ApiError(400, '搜索词最多 100 字'));

    const { result } = renderHook(() => useSearch('登录', false));

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toEqual({ status: 'failed', message: '搜索词最多 100 字' });
  });
});
