import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, applyTheme, storedTheme, systemTheme } from '../src/lib/theme';
import { stubMatchMedia } from './mediaStub';

/** 主题偏好的读取与落盘。UI 那一层在 useTheme / ThemeToggle 的用例里。 */

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

describe('storedTheme', () => {
  it('没存过时是 null（表示跟随系统），而不是猜一个浅色', () => {
    stubMatchMedia(true);

    expect(storedTheme()).toBeNull();
  });

  it('存过就按存的来，不管系统怎么设', () => {
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_KEY, JSON.stringify('light'));

    expect(storedTheme()).toBe('light');
  });

  it('存了认不出的值时当作没存过', () => {
    window.localStorage.setItem(THEME_KEY, JSON.stringify('blue'));

    expect(storedTheme()).toBeNull();
  });
});

describe('systemTheme', () => {
  it('系统是深色就是深色', () => {
    stubMatchMedia(true);

    expect(systemTheme()).toBe('dark');
  });

  it('没有 matchMedia 时按浅色算，而不是抛异常', () => {
    // jsdom 本来就没有 matchMedia，这里故意不装 stub。
    expect(typeof window.matchMedia).toBe('undefined');

    expect(systemTheme()).toBe('light');
  });
});

describe('applyTheme', () => {
  it('只负责 html 上的 dark 类，深色那套值由 CSS 认这个类', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
