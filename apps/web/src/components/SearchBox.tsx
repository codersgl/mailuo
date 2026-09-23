import type { KeyboardEvent } from 'react';
import { MAX_QUERY_LENGTH } from '../domain/search';

/**
 * 顶栏搜索框。只画控件，不管结果：关键词、选中项与键盘动作都在 BoardPage 里
 * （选择状态要同时给结果页用，所以不能留在这个组件内部）。
 *
 * 宽度 240px（定版原型 C 的取值），但**可以被压到 110px**：顶栏是横向 flex，
 * 窄屏（375px）下品牌 + 搜索框 + 主题控件三样放不下，固定宽度会把主题控件顶出视口
 * （实测 header.scrollWidth 491 > 375）。让搜索框参与收缩，面包屑本来就能缩到 0 并横滚。
 */
export function SearchBox({
  value,
  onValueChange,
  onKeyDown,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="relative ml-auto flex w-[240px] min-w-[110px] items-center">
      <span
        className="pointer-events-none absolute left-2 grid place-items-center text-ink-3"
        aria-hidden="true"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        >
          <circle cx="5.2" cy="5.2" r="3.2" />
          <path d="M7.6 7.6 10 10" />
        </svg>
      </span>
      <input
        type="text"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="搜索任务标题与描述"
        aria-label="搜索任务"
        autoComplete="off"
        spellCheck={false}
        // 上限与后端同一个数：敲不进去比让后端回一条「q: 搜索词最多 100 字」友好。
        maxLength={MAX_QUERY_LENGTH}
        className="h-[26px] w-full rounded-[5px] border border-line bg-surface-2 pl-[25px] pr-[26px] text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent-border focus:bg-surface focus:ring-2 focus:ring-accent-weak"
      />
      {/* 只在有内容时给清除按钮：空框上挂一个 × 既是死按钮，也会让 placeholder 变短。 */}
      {value !== '' && (
        <button
          type="button"
          onClick={() => onValueChange('')}
          aria-label="清空搜索"
          className="absolute right-1 grid size-[18px] place-items-center rounded-[4px] text-ink-3 hover:bg-track hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      )}
    </div>
  );
}
