import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY } from '../src/lib/theme';
import { stubMatchMedia } from './mediaStub';

/**
 * index.html 里那段内联脚本是「刷新时不会先闪一下浅色」的唯一保障。
 * 它是裸字符串：没有类型检查，改了 key 或者改了取值格式也不会有人提醒。
 * 所以这里把脚本真的抽出来执行一遍——用 THEME_KEY 写入，再断言 html 上的类对不对，
 * 这样「两份判断逻辑必须一致」就成了会红的事实，而不是注释里的约定。
 */

function runBootScript(): void {
  const file = path.join(import.meta.dirname, '..', 'index.html');
  // 用特征串定位那一段，而不是「第一个 <script>」：以后在它前面再加一段内联脚本（埋点、polyfill），
  // 取第一个会静默地去执行另一段代码，测试照样绿。
  const script = /<script>([\s\S]*?prefers-color-scheme[\s\S]*?)<\/script>/.exec(
    fs.readFileSync(file, 'utf8'),
  )?.[1];
  if (script === undefined) throw new Error('index.html 里找不到内联的主题脚本');
  new Function(script)();
}

const hasDark = () => document.documentElement.classList.contains('dark');

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

describe('index.html 的首屏定色', () => {
  it('存过深色就预先挂上 dark 类', () => {
    stubMatchMedia(false);
    window.localStorage.setItem(THEME_KEY, JSON.stringify('dark'));

    runBootScript();

    expect(hasDark()).toBe(true);
  });

  it('存过浅色时即使系统是深色也不挂', () => {
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_KEY, JSON.stringify('light'));

    runBootScript();

    expect(hasDark()).toBe(false);
  });

  it('没存过就跟随系统', () => {
    stubMatchMedia(true);

    runBootScript();

    expect(hasDark()).toBe(true);
  });

  it('存了认不出的值时按没存过处理，跟随系统', () => {
    // 与 lib/theme.ts 的 isTheme 是同一套判断，但那是另一份实现，得单独钉住。
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_KEY, JSON.stringify('blue'));

    runBootScript();

    expect(hasDark()).toBe(true);
  });

  it('没有 matchMedia 时不抛异常，按浅色走', () => {
    expect(typeof window.matchMedia).toBe('undefined');

    expect(() => runBootScript()).not.toThrow();
    expect(hasDark()).toBe(false);
  });

  it('localStorage 不可用时不抛异常', () => {
    stubMatchMedia(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(() => runBootScript()).not.toThrow();
  });
});
