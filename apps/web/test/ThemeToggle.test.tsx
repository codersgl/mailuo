import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from '../src/components/ThemeToggle';
import { stubMatchMedia } from './mediaStub';

/**
 * 顶栏的主题控件。
 *
 * 这里只测「控件到 useTheme 的接线」：三个选项在不在、按下态跟不跟 choice、点下去有没有生效。
 * 偏好怎么写盘、监听怎么拆，是 useTheme 的契约，在 useTheme.test.ts 里测，不在这儿重复。
 */

const hasDark = () => document.documentElement.classList.contains('dark');

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

function renderToggle() {
  render(<ThemeToggle />);
  return within(screen.getByRole('group', { name: '主题' }));
}

describe('ThemeToggle', () => {
  it('三个选项，没选过时「跟随系统」是按下态', () => {
    stubMatchMedia(false);

    const toggle = renderToggle();

    expect(toggle.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '跟随系统',
      '浅色',
      '深色',
    ]);
    expect(toggle.getByRole('button', { name: '跟随系统' }).getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getByRole('button', { name: '深色' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('点「深色」：html 挂上 dark，按下态跟着换', () => {
    stubMatchMedia(false);
    const toggle = renderToggle();

    fireEvent.click(toggle.getByRole('button', { name: '深色' }));

    expect(hasDark()).toBe(true);
    expect(toggle.getByRole('button', { name: '深色' }).getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getByRole('button', { name: '跟随系统' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('点「跟随系统」把选择交还给系统', () => {
    stubMatchMedia(true);
    const toggle = renderToggle();
    fireEvent.click(toggle.getByRole('button', { name: '浅色' }));
    expect(hasDark()).toBe(false);

    fireEvent.click(toggle.getByRole('button', { name: '跟随系统' }));

    // 系统是深色，交还之后立刻变深，按下态也回到「跟随系统」。
    expect(hasDark()).toBe(true);
    expect(toggle.getByRole('button', { name: '跟随系统' }).getAttribute('aria-pressed')).toBe('true');
  });
});
