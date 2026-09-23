import { cx } from '../lib/cx';
import type { ReminderFill } from '../domain/reminder';

/**
 * 工期进度条：轨道 + 按「已用 / 工期」定宽的填充（定版原型 B）。
 *
 * 抽成组件是因为卡片与任务树两处都要画，而三档填充色的映射只能有一份——
 * 两处各写一遍，改色时必然漏掉一个。尺寸、圆角、定位由调用方通过 className 给：
 * 卡片那条是贴着卡片下沿的绝对定位元素，树里那条是 24×3 的行内小条。
 *
 * 只映射已有令牌（accent-border / accent / danger / track），不新增颜色。
 */
const FILL_CLASS: Record<ReminderFill, string> = {
  weak: 'bg-accent-border',
  near: 'bg-accent',
  over: 'bg-danger',
};

export function DurationBar({
  fill,
  percent,
  detail,
  accessible,
  className,
}: {
  fill: ReminderFill;
  /** 填充宽度百分比，0~100。 */
  percent: number;
  /** 完整文案（工期 / 已用 / 剩多久），放到 title 上。 */
  detail: string;
  /**
   * 是否把这条进度条当成有含义的图形。卡片上有可见小字时传 false——那时信息已经由文字说出，
   * 再给条一个可访问名字会让读屏把同一件事念两遍（与卡片里子任务进度条 aria-hidden 同一考虑）。
   */
  accessible: boolean;
  className: string;
}) {
  return (
    <span
      /*
       * 两个 data 属性各有用途，别合并成一个：
       * - `data-duration-track` 是常量，只要这个组件被渲染就一定在。用例用它判「有没有画条」——
       *   若用 `data-duration-bar`（值是 fill）来判，未估工期那种 fill 为 null 的情况会让
       *   React 直接省略属性，于是「不小心给未估任务也画了条」反而测不出来。
       * - `data-duration-bar` 的值是档位，用例与验收脚本按它断言画的是哪一档。
       */
      data-duration-track=""
      data-duration-bar={fill}
      role={accessible ? 'img' : undefined}
      aria-label={accessible ? detail : undefined}
      aria-hidden={accessible ? undefined : true}
      title={detail}
      className={cx(className, 'block')}
    >
      <i className={cx('block h-full', FILL_CLASS[fill])} style={{ width: `${percent}%` }} />
    </span>
  );
}
