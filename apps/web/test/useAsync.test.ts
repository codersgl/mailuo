import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAsync } from '../src/hooks/useAsync';
import { ApiError } from '../src/api/client';

/**
 * useAsync 是三处读取（看板 / 文件树 / 面包屑）共用的底座，
 * 这里只测用真实接口路径测不到的两点：非 ApiError 的兜底文案、deps 变化时的竞态。
 * 三种状态、重试、卸载的行为在 useBoard.test.ts 里用真实调用方覆盖。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAsync', () => {
  it('非 ApiError 的异常用调用方给的兜底文案', async () => {
    const { result } = renderHook(() =>
      useAsync(() => Promise.reject(new Error('bug')), [], '加载看板失败'),
    );

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toEqual({ status: 'failed', message: '加载看板失败' });
  });

  it('ApiError 的中文文案原样带出，不用兜底', async () => {
    const { result } = renderHook(() =>
      useAsync(() => Promise.reject(new ApiError(404, '任务不存在')), [], '加载看板失败'),
    );

    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state).toEqual({ status: 'failed', message: '任务不存在' });
  });

  it('deps 里任意一项变化都会重取，且晚回来的旧结果被丢弃', async () => {
    const resolvers: Array<(value: string) => void> = [];
    const load = (label: string) => () =>
      new Promise<string>((resolve) => {
        resolvers.push((value) => resolve(`${label}:${value}`));
      });

    const { result, rerender } = renderHook(
      ({ label }: { label: string }) => useAsync(load(label), [label], '失败'),
      { initialProps: { label: 'a' } },
    );
    await waitFor(() => expect(resolvers).toHaveLength(1));

    rerender({ label: 'b' });
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // 后发起的先回来，先发起的后回来：'a' 的结果必须被忽略。
    resolvers[1]!('done');
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    resolvers[0]!('done');
    // 等旧请求的 then 回调真的跑完，否则「晚到的结果被丢弃」可能因为还没执行而假通过。
    await act(async () => {});

    expect(result.current.state).toEqual({ status: 'ready', data: 'b:done' });
  });

  it('reload 会重新取一次', async () => {
    const load = vi.fn(() => Promise.resolve('第一版'));
    const { result } = renderHook(() => useAsync(load, [], '失败'));
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: '第一版' }));

    load.mockResolvedValue('第二版');
    act(() => result.current.reload());

    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: '第二版' }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('refresh 静默重取：新数据回来之前一直显示旧数据', async () => {
    let resolveSecond: ((value: string) => void) | undefined;
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('第一版')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const { result } = renderHook(() => useAsync(load, [], '失败'));
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: '第一版' }));

    act(() => result.current.refresh());

    // 请求还在飞：不能像 reload 那样把数据清成 loading，否则整块看板会闪一下。
    expect(result.current.state).toEqual({ status: 'ready', data: '第一版' });

    resolveSecond?.('第二版');
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: '第二版' }));
  });

  it('refresh 失败时保留已经显示的数据，不把可用的界面换成错误页', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('第一版')
      .mockRejectedValueOnce(new ApiError(500, '服务挂了'));

    const { result } = renderHook(() => useAsync(load, [], '失败'));
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: '第一版' }));

    act(() => result.current.refresh());
    await act(async () => {});

    expect(result.current.state).toEqual({ status: 'ready', data: '第一版' });
  });

  it('refresh 与 deps 变化撞在同一轮时按非静默处理：换数据必须回到 loading', async () => {
    const resolvers = new Map<string, (value: string) => void>();
    const load = (label: string) => () =>
      new Promise<string>((resolve) => {
        resolvers.set(label, resolve);
      });

    const { result, rerender } = renderHook(
      ({ label }: { label: string }) => useAsync(load(label), [label], '失败'),
      { initialProps: { label: 'a' } },
    );
    await waitFor(() => expect(resolvers.has('a')).toBe(true));
    resolvers.get('a')!('a 的数据');
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: 'a 的数据' }));

    act(() => {
      result.current.refresh();
      rerender({ label: 'b' });
    });

    // 若把这一轮也当静默重取，界面会短暂显示 a 的数据却标着 b 的地址。
    expect(result.current.state.status).toBe('loading');
  });

  it('过期请求的失败不会覆盖新数据（catch 里的守卫）', async () => {
    let failStale: (cause: unknown) => void = () => {};
    const load = (label: string) => () =>
      label === 'a'
        ? new Promise<string>((_, reject) => {
            failStale = reject;
          })
        : Promise.resolve('b 的结果');

    const { result, rerender } = renderHook(
      ({ label }: { label: string }) => useAsync(load(label), [label], '失败'),
      { initialProps: { label: 'a' } },
    );

    rerender({ label: 'b' });
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: 'b 的结果' }));

    // 旧请求这时才失败：如果 catch 里没有 cancelled 守卫，界面会从 ready 退回 failed。
    failStale(new Error('旧请求失败'));
    await act(async () => {});

    expect(result.current.state).toEqual({ status: 'ready', data: 'b 的结果' });
  });
});
