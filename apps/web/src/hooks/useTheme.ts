import { useCallback, useEffect, useState } from 'react';
import { removeStored, writeStored } from '../lib/storage';
import { THEME_KEY, applyTheme, storedTheme, systemTheme } from '../lib/theme';
import type { Theme } from '../lib/theme';

/**
 * 主题偏好与落盘：对外只给出「用户选了什么」和「怎么改」。
 *
 * `choice` 为 null 表示跟随系统。生效的是哪一套不对外暴露——把 `dark` 类挂到 html 上
 * 是这个 hook 自己的事（`applyTheme`），组件只认 CSS 令牌，不需要知道当前是深是浅。
 *
 * 为什么不用 usePersistentState：那个 hook 在挂载时就会把初始值写回 localStorage。
 * 而「没选过」是一个有意义的状态——只要落盘过，之后就再也不会跟随系统了
 * （规范要求「首次访问跟随 prefers-color-scheme，用户手动切换后以本地偏好为准」）。
 * 所以这里只在用户真的点过之后才写。
 */
export function useTheme(): {
  choice: Theme | null;
  choose: (choice: Theme | null) => void;
} {
  const [choice, setChoice] = useState<Theme | null>(() => storedTheme());
  /**
   * 系统的当前偏好，只在 choice 为 null 时参与。
   * 存成 state 是为了「跟随系统」期间用户在系统设置里切了深浅，页面能跟着变——
   * 不然要刷新一次才生效，看起来像没跟上。
   */
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme = choice ?? system;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (choice !== null) return;
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [choice]);

  const choose = useCallback((next: Theme | null) => {
    setChoice(next);
    if (next === null) {
      // 交还给系统：选「跟随系统」= 删掉偏好，而不是存一个特殊值（见 lib/storage.ts 的 removeStored）。
      removeStored(THEME_KEY);
      /**
       * 必须重新读一次系统偏好。不跟随时上面的监听是拆掉的，state 里那份 `system`
       * 停留在「最后一次不跟随」的时刻。例：系统深色 → 用户选浅色（拆掉监听）→ 期间系统变成浅色
       * → 用户点「跟随系统」，此时若直接用 state，页面会跳回深色，而系统明明是浅色。
       */
      setSystem(systemTheme());
    } else {
      writeStored(THEME_KEY, next);
    }
  }, []);

  return { choice, choose };
}
