import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoute } from '../src/hooks/useRoute';

/**
 * 路由接在浏览器历史上：navigate 用 pushState，后退/前进靠 popstate 事件回到 state。
 * jsdom 不会因为 pushState 触发 popstate，所以这里手动派发事件模拟后退。
 */

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('useRoute', () => {
  it('初始状态解析当前 URL', () => {
    window.history.replaceState(null, '', '/board/t1');

    const { result } = renderHook(() => useRoute());

    expect(result.current.route).toEqual({ kind: 'board', boardId: 't1' });
  });

  it('navigate 同时改 URL 和 state', () => {
    const { result } = renderHook(() => useRoute());

    act(() => result.current.navigate('t2'));

    expect(window.location.pathname).toBe('/board/t2');
    expect(result.current.route).toEqual({ kind: 'board', boardId: 't2' });
  });

  it('navigate(null) 回到根看板', () => {
    window.history.replaceState(null, '', '/board/t2');
    const { result } = renderHook(() => useRoute());

    act(() => result.current.navigate(null));

    expect(window.location.pathname).toBe('/');
    expect(result.current.route).toEqual({ kind: 'board', boardId: null });
  });

  it('popstate 时从 URL 重新解析（后退键）', () => {
    const { result } = renderHook(() => useRoute());

    // 模拟用户按后退：URL 已经变了，只剩 popstate 事件通知组件。
    act(() => {
      window.history.pushState(null, '', '/board/t3');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.route).toEqual({ kind: 'board', boardId: 't3' });
  });

  it('导航到当前这一层不新增历史记录', () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useRoute());

    act(() => result.current.navigate(null));

    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
  });

  it('当前 URL 多一个结尾斜杠时，仍算同一层，不新增历史记录', () => {
    window.history.replaceState(null, '', '/board/t5/');
    const pushState = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useRoute());

    act(() => result.current.navigate('t5'));

    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
  });

  it('replace 选项只替换当前历史记录', () => {
    window.history.replaceState(null, '', '/nonsense');
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const { result } = renderHook(() => useRoute());

    // 「从坏地址回根看板」用 replace：坏地址不该留在历史里等着被后退回来。
    act(() => result.current.navigate(null, { replace: true }));

    expect(replaceState).toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(result.current.route).toEqual({ kind: 'board', boardId: null });
    pushState.mockRestore();
    replaceState.mockRestore();
  });

  it('认不出的路径进入 notFound，并带上原路径', () => {
    window.history.replaceState(null, '', '/nonsense');

    const { result } = renderHook(() => useRoute());

    expect(result.current.route).toEqual({ kind: 'notFound', pathname: '/nonsense' });
  });

  it('卸载时摘掉 popstate 监听', () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useRoute());

    unmount();

    // 断言清理本身：React 19 会静默忽略已卸载组件的 setState，
    // 只靠「卸载后派发事件看 state 变不变」是观测不到监听器有没有摘掉的。
    expect(removeEventListener).toHaveBeenCalledWith('popstate', expect.any(Function));
    removeEventListener.mockRestore();
  });
});
