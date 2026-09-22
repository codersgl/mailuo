/**
 * 卡片上几个数值的展示口径。放在这里而不是组件里，是为了能单独测。
 *
 * 工期的存储单位是分钟（见 docs/spec.md 的「关键路径」）：`null` 表示未估工期，
 * `0` 表示瞬时任务，其余是分钟数。「天」和「小时」只是展示时的换算，
 * 1 天 = 480 分钟（8 小时工作制），不参与任何日历计算。
 */

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 480;

/**
 * 工期文案。三种状态必须能一眼分辨：未估 / 瞬时 / 具体工期。
 * 负数在契约外（后端 schema 已挡住），这里兜底按瞬时处理，免得界面上出现负的工期。
 */
export function formatDuration(durationMinutes: number | null): string {
  if (durationMinutes === null) return '未估工期';
  if (durationMinutes <= 0) return '瞬时';
  return `工期 ${groupMinutes(durationMinutes)}`;
}

/**
 * 工期是否已估。0 也算已估：它表示瞬时任务，而不是「还没填」。
 * 注意契约外的负数也会返回 true（它同样不是 null），与 D32 的三态有一处偏差——
 * 但接口 schema 不允许负数，界面上也不会因此显示错的东西。
 */
export function isDurationEstimated(durationMinutes: number | null): boolean {
  return durationMinutes !== null;
}

/** 折成「N 天 M 小时 K 分」，只保留非零的部分；不到一天的时长不会显示「0 天」。 */
function groupMinutes(total: number): string {
  const days = Math.floor(total / MINUTES_PER_DAY);
  const rest = total % MINUTES_PER_DAY;
  const hours = Math.floor(rest / MINUTES_PER_HOUR);
  const minutes = rest % MINUTES_PER_HOUR;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  return parts.join(' ');
}

/** 子任务进度文案，例如 `1/2 子任务`。没有子任务时是 `0/0 子任务`，与原型一致。 */
export function formatProgress(childDone: number, childTotal: number): string {
  return `${childDone}/${childTotal} 子任务`;
}

/**
 * 进度条宽度百分比。没有子任务时返回 0，避免 0/0 出现除零；
 * `<= 0` 同样是为了兜住契约外的脏数据（计数由后端算出，一定是非负的）。
 */
export function progressPercent(childDone: number, childTotal: number): number {
  if (childTotal <= 0) return 0;
  return Math.round((childDone / childTotal) * 100);
}
