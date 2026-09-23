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
 * 工期上限：9999 天。后端 `apps/api/src/domain/duration.ts` 的 `MAX_DURATION_MINUTES` 是同一个数，
 * 那边负责拒绝（400），这边负责在输入时就给出提示。改一处要改两处。
 *
 * 前端这一侧挡住的是两类输入：
 *
 * - 极长的数字（300 位以上）让 `Number()` 得到 `Infinity`，而 `JSON.stringify(Infinity)` 是 `null`
 *   ——界面预览写着「工期 Infinity 天」，请求发出去却成了「未估工期」，还会提示「已保存」。
 *   这是静默改数据，后端拦不住（它收到的是合法的 null），只能在发请求前挡住。
 * - 大到超过上限、但仍是安全整数的值（例如 `Number.MAX_SAFE_INTEGER`）：后端会返回 400，只是文案是
 *   「工期最多 9999 天」，不如在输入框旁边直接显示「工期必须是 0 到 9999 天之间的整数」。
 */
export const MAX_DURATION_MINUTES = 9999 * MINUTES_PER_DAY;

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
 * 工期文案的短形式：`1 天 4 小时` / `未估` / `瞬时`。
 *
 * 依赖候选行的右侧只有几十像素，`formatDuration` 那种「工期 」前缀在这里会挤掉标题。
 * 两种形式共用下面同一套换算，不会出现「卡片说 1 天 4 小时、候选行说 5 小时」的不一致。
 */
export function formatDurationShort(durationMinutes: number | null): string {
  if (durationMinutes === null) return '未估';
  if (durationMinutes <= 0) return '瞬时';
  return groupMinutes(durationMinutes);
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
  const { days, hours, minutes } = splitMinutes(total);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  return parts.join(' ');
}

/** 分钟数按 480 / 60 拆成天、小时、分三段。展示与编辑输入共用同一套换算。 */
export function splitMinutes(total: number): { days: number; hours: number; minutes: number } {
  const days = Math.floor(total / MINUTES_PER_DAY);
  const rest = total % MINUTES_PER_DAY;
  return { days, hours: Math.floor(rest / MINUTES_PER_HOUR), minutes: rest % MINUTES_PER_HOUR };
}

/**
 * 工期编辑框里的三段文本。用一个「数字 + 单位」的输入框表示不了 3 天 4 小时这种混合值
 * （写进去只能四舍五入，保存时会悄悄改掉工期），所以按 天 / 小时 / 分 拆成三个框。
 */
export interface DurationParts {
  days: string;
  hours: string;
  minutes: string;
}

/** 已有工期 → 三个输入框的初始文本。空串表示这一段是 0。 */
export function splitDuration(durationMinutes: number | null): DurationParts {
  // null 是「未估」，三个框都留空；0 是「瞬时」，必须在界面上与未估区分开，所以落到分钟段上。
  if (durationMinutes === null) return { days: '', hours: '', minutes: '' };
  if (durationMinutes === 0) return { days: '', hours: '', minutes: '0' };

  const { days, hours, minutes } = splitMinutes(durationMinutes);
  return {
    days: days > 0 ? String(days) : '',
    hours: hours > 0 ? String(hours) : '',
    minutes: minutes > 0 ? String(minutes) : '',
  };
}

/** 三段输入读出来的结果：未估（全空）、具体分钟数、或者输入非法。 */
export type DurationInput =
  | { kind: 'unset' }
  | { kind: 'minutes'; value: number }
  | { kind: 'invalid' };

/**
 * 读三个工期输入框。全空按「未估工期」处理（null），否则求和换算成分钟。
 * 空串以外的内容必须是纯数字：负数、小数点、`1e3` 一律算非法，而不是被 parseInt 悄悄截断。
 */
export function readDurationInput(parts: DurationParts): DurationInput {
  const values: number[] = [];
  for (const text of [parts.days, parts.hours, parts.minutes]) {
    const trimmed = text.trim();
    if (trimmed === '') {
      values.push(0);
      continue;
    }
    if (!/^\d+$/.test(trimmed)) return { kind: 'invalid' };
    values.push(Number(trimmed));
  }

  // 全空是「没估工期」；三段里只要写了一个数（哪怕写的是 0）就是估过的工期。
  if (parts.days.trim() === '' && parts.hours.trim() === '' && parts.minutes.trim() === '') {
    return { kind: 'unset' };
  }

  const [days, hours, minutes] = values as [number, number, number];
  const total = days * MINUTES_PER_DAY + hours * MINUTES_PER_HOUR + minutes;
  // 上限与 Infinity 都在这里挡住，理由见 MAX_DURATION_MINUTES 的注释：超限要走前端的提示，
  // Infinity 则是必须在发请求前拦下（发出去会变成 null，静默存成未估）。
  if (!Number.isFinite(total) || total > MAX_DURATION_MINUTES) return { kind: 'invalid' };
  return { kind: 'minutes', value: total };
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
