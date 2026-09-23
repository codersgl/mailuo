import { useTheme } from '../hooks/useTheme';
import type { Theme } from '../lib/theme';
import { cx } from '../lib/cx';

/**
 * 顶栏右端的主题控件：跟随系统 / 浅色 / 深色。
 *
 * 三态而不是两态，是为了留一个「交还给系统」的出口：只有浅色/深色两态时，
 * 用户点过一次就永远回不到跟随系统了。
 *
 * 用三个带 aria-pressed 的按钮，而不是 radiogroup / input[type=radio]：
 * 前者只需 Tab 与回车，不用实现一组方向键；代价是读屏把每一项读成「切换按钮 已按下」，
 * 而不是读成「三选一，当前是某项」。对一个三选项的个人工具，这个代价可以接受。
 */
const OPTIONS: ReadonlyArray<{ choice: Theme | null; label: string }> = [
  { choice: null, label: '跟随系统' },
  { choice: 'light', label: '浅色' },
  { choice: 'dark', label: '深色' },
];

/** 与卡片「⋯」、列头「+」、侧栏开关保持同一套聚焦环，免得顶栏里出现两种焦点样式。 */
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border';

export function ThemeToggle() {
  const { choice, choose } = useTheme();

  return (
    <div
      role="group"
      aria-label="主题"
      className="ml-auto flex flex-none items-center gap-0.5 rounded-[5px] border border-line p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = choice === option.choice;
        return (
          <button
            key={option.label}
            type="button"
            aria-pressed={active}
            onClick={() => choose(option.choice)}
            className={cx(
              'h-[20px] rounded-[4px] px-[7px] text-[11px]',
              FOCUS_RING,
              active
                ? 'bg-accent-weak font-semibold text-accent'
                : 'text-ink-2 hover:bg-track hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
