import { readStored } from './storage';

/**
 * 主题偏好的读与用。
 *
 * 这里只放「不需要 React」的部分：判断当前该用哪套配色、把它写到 html 上。
 * 需要跟随 React 状态的部分在 hooks/useTheme.ts。
 *
 * 同样的判断在 apps/web/index.html 里有一份内联副本，用来在首屏渲染前定色（防闪烁）。
 * 两份必须一致——test/themeBoot.test.ts 会真的执行那段内联脚本，不一致就会红。
 */

/** 主题偏好在 localStorage 里的 key。与其他前端偏好一样以 `kanban.` 开头。 */
export const THEME_KEY = 'kanban.theme';

export type Theme = 'light' | 'dark';

const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

/**
 * 系统当前偏好。
 *
 * jsdom 与少数老浏览器没有 matchMedia，这时按浅色算：主题猜错只是观感问题，
 * 为了猜它让页面在初始化时就抛异常不值得。
 */
export function systemTheme(): Theme {
  if (typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 用户手动选过的偏好。null 表示没选过，此时跟随系统（见 docs/spec.md 的「主题」）。 */
export function storedTheme(): Theme | null {
  return readStored<Theme | null>(THEME_KEY, null, isTheme);
}

/**
 * 把配色落到 html 上。深色的判定依据就是这个 class，
 * 组件本身不认识主题——它们只读 CSS 变量（见 src/index.css 的 `.dark`）。
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}
