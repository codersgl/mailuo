import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

/** 主区正在看哪一种视图。依赖图的实现见 components/DependencyGraph.tsx。 */
export type ViewMode = 'board' | 'graph';

const VIEWS: Array<{ id: ViewMode; label: string }> = [
  { id: 'board', label: '看板' },
  { id: 'graph', label: '依赖图' },
];

/**
 * 主区顶部的视图切换条：左边是「看板 / 依赖图」分段控件，右边留给当前视图自己的控件
 * （依赖图放图例与缩放，看板什么都不放）。
 *
 * 分段控件放在主区而不是顶栏：顶栏已经有面包屑、搜索框与主题控件，窄屏下再塞一个控件会把
 * 主题控件顶出视口（D45 记过这个坑）。放在主区顶部也正好挨着它控制的内容。
 */
export function ViewToolbar({
  view,
  onViewChange,
  children,
}: {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  /** 右侧控件。依赖图传图例与缩放，看板不传。 */
  children?: ReactNode;
}) {
  return (
    /*
     * overflow-x-auto：窄屏（375px）下左侧任务树占 252px，主区只剩 123px，依赖图那一排
     * 「图例 + 缩放 + 适应窗口」放不下。这里选择横向滚动而不是裁掉：看板在同样的宽度下也是
     * 横向滚动（网格 min-w-[780px]），用户已经熟悉这个手势，而裁掉会让缩放按钮彻底够不着。
     * 收起任务树（D46）后宽度足够，正常情况下不会出现滚动条。
     */
    <div className="flex h-[42px] flex-none items-center gap-2.5 overflow-x-auto border-b border-line bg-surface px-4">
      {/* role=group + aria-pressed 而不是 tablist：这里没有 tabpanel 与「选中即切换面板」的语义，
          两个按钮各自表达「当前主区正在看哪一种视图」更准确。 */}
      <div role="group" aria-label="视图切换" className="inline-flex flex-none rounded-[6px] bg-track p-0.5">
        {VIEWS.map((item) => {
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              onClick={() => onViewChange(item.id)}
              className={cx(
                'h-[24px] rounded-[4px] px-3 text-[12.5px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border',
                active
                  ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                  : 'text-ink-2 hover:text-ink',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {/* 把右侧控件推到另一头。右侧控件都是 flex-none，窄屏下宁可整体横向滚动也不压缩它们。 */}
      <span className="flex-1" />
      {children}
    </div>
  );
}
