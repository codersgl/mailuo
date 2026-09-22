/**
 * 卡片上几个数值的展示口径。放在这里而不是组件里，是为了能单独测：
 * 「工期 0 表示未估工期」是规范里的语义（见 docs/spec.md 的「状态语义」），
 * 写成 0 天会让界面看起来像有一个瞬时任务，含义完全不同。
 */

/**
 * 工期文案：0 天表示还没估，文案要能一眼分辨。
 * 用 `<= 0` 而不是 `=== 0`：接口 schema 已保证非负，这里只是兜住脏数据，
 * 免得界面上出现「工期 -1 天」这种读起来像有意义的数字。
 */
export function formatDuration(duration: number): string {
  return duration <= 0 ? '未估工期' : `工期 ${duration} 天`;
}

/** 工期是否已估算。未估的用虚线 chip 弱化（原型 A 的写法）。 */
export function isDurationEstimated(duration: number): boolean {
  return duration > 0;
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
