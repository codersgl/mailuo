import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOW_INTERVAL_MS, useNow } from '../src/hooks/useNow';

/**
 * `useNow` 是「提醒随时间的流逝自己变档」这个设计唯一的承载者，而所有组件用例都是把 `nowMs`
 * 当参数传进去的——也就是说这个 hook 不测的话，「tick 间隔改错」「卸载漏了 clearInterval」
 * 「定时器不更新值」这三种改坏都不会让任何用例变红（审阅的变异检验确认过）。
 */

const T0 = '2024-01-01T00:00:00.000Z';
const T0_MS = Date.parse(T0);

/** 把 hook 的返回值印到 DOM 上，用例从属性里读，避免在渲染期做副作用。 */
function Harness({ intervalMs }: { intervalMs?: number | null }) {
  const nowMs = useNow(intervalMs);
  return <span data-testid="now" data-now={String(nowMs)} />;
}

function readNow(getByTestId: (id: string) => HTMLElement): number {
  return Number(getByTestId('now').getAttribute('data-now'));
}

describe('useNow', () => {
  it('初始值就是当前时刻', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const { getByTestId } = render(<Harness />);

    expect(readNow(getByTestId)).toBe(T0_MS);
  });

  it(`每过 ${DEFAULT_NOW_INTERVAL_MS / 1000} 秒把「现在」往前推一次`, () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const { getByTestId } = render(<Harness />);

    act(() => {
      vi.advanceTimersByTime(DEFAULT_NOW_INTERVAL_MS);
    });
    expect(readNow(getByTestId)).toBe(T0_MS + DEFAULT_NOW_INTERVAL_MS);

    // 连续两次 tick 会累加，不是每次都取挂载那一刻。
    act(() => {
      vi.advanceTimersByTime(DEFAULT_NOW_INTERVAL_MS);
    });
    expect(readNow(getByTestId)).toBe(T0_MS + 2 * DEFAULT_NOW_INTERVAL_MS);
  });

  it('卸载后不留定时器', () => {
    vi.useFakeTimers();
    const { unmount } = render(<Harness />);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    // 看板与任务树是按视图挂载的，漏清理会每切一次视图泄漏一个永久定时器。
    expect(vi.getTimerCount()).toBe(0);
  });

  it('intervalMs 传 null 时不装定时器，值也不再前进', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const { getByTestId } = render(<Harness intervalMs={null} />);

    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(DEFAULT_NOW_INTERVAL_MS * 4);
    });
    expect(readNow(getByTestId)).toBe(T0_MS);
  });

  it('传了自定义间隔就按它 tick', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    const { getByTestId } = render(<Harness intervalMs={1000} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(readNow(getByTestId)).toBe(T0_MS + 1000);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
