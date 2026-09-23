import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../src/hooks/useTheme';
import { THEME_KEY } from '../src/lib/theme';
import { stubMatchMedia } from './mediaStub';

/**
 * 主题的三态语义：没选过时跟随系统，选过之后以本地偏好为准，选回「跟随系统」要能真的交还回去。
 *
 * 断言尽量落在 html 上的 `dark` 类而不是 hook 的返回值：那才是这个 hook 对外唯一的产物
 * （组件只认 CSS 令牌，不读当前主题）。
 */

const hasDark = () => document.documentElement.classList.contains('dark');

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

describe('useTheme', () => {
  it('没选过时跟随系统，并且不往 localStorage 里写', () => {
    stubMatchMedia(true);

    const { result } = renderHook(() => useTheme());

    expect(result.current.choice).toBeNull();
    expect(hasDark()).toBe(true);
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it('选了浅色就写偏好并摘掉 dark 类', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.choose('light'));

    expect(hasDark()).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(THEME_KEY) ?? 'null')).toBe('light');
  });

  it('跟随系统期间系统变了，页面跟着变', () => {
    const media = stubMatchMedia(false);
    renderHook(() => useTheme());
    expect(hasDark()).toBe(false);
    expect(media.listenerCount).toBe(1);

    act(() => media.setDark(true));

    expect(hasDark()).toBe(true);
  });

  it('一旦选过就不再跟随系统，而且拆掉系统监听', () => {
    const media = stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());

    act(() => result.current.choose('light'));

    expect(media.listenerCount).toBe(0);
    // 系统是深色、用户选了浅色：翻来翻去都不该把页面拽回深色。
    act(() => media.setDark(false));
    act(() => media.setDark(true));
    expect(hasDark()).toBe(false);
  });

  it('选回「跟随系统」会删掉偏好并重新跟随', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.choose('light'));

    act(() => result.current.choose(null));

    // 删掉而不是存一个特殊值，这样 localStorage 里不会留一条看不懂的记录。
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(result.current.choice).toBeNull();
    expect(hasDark()).toBe(true);
  });

  it('不跟随期间系统变过，交还时按现在的系统来（不是离开时那份）', () => {
    const media = stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(hasDark()).toBe(true);

    // 用户选浅色，监听被拆掉；之后系统变成浅色，此时页面上没有任何人在听。
    act(() => result.current.choose('light'));
    act(() => media.setDark(false));

    act(() => result.current.choose(null));

    // 交还要重新读一次系统偏好：用离开时那份陈旧的 system，页面会跳回深色。
    expect(hasDark()).toBe(false);
    expect(media.listenerCount).toBe(1);
  });

  it('没有 matchMedia 时也能用：按浅色起步，点深色照样生效', () => {
    // jsdom 本来就没有 matchMedia，这里故意不装 stub。
    const { result } = renderHook(() => useTheme());
    expect(hasDark()).toBe(false);

    act(() => result.current.choose('dark'));

    expect(hasDark()).toBe(true);
  });
});
