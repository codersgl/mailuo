import { DONE_COLUMN_ID } from './columns';
import { formatScheduleMinutes } from '../lib/format';

/**
 * 工期提醒的判定（见 docs/spec.md 的「工期提醒」）。
 *
 * 判定放在前端而不是后端，是因为它会随时间的流逝自己变：后端只存事实（工期、已用、
 * 这一段何时开始），同一个任务在两次取数之间会从「未到 90%」走到「临近」再走到「超期」，
 * 前端必须用本地的 now 重算。两处各算一份就是两份实现，迟早分叉。
 */

/** 进度条的填充档：弱填充（还在跑、没到 90%）、临近、超期。 */
export type ReminderFill = 'weak' | 'near' | 'over';

export interface ReminderView {
  /** 该画哪一档；null 表示这个任务不画条也不给小字。 */
  fill: ReminderFill | null;
  /** 进度条宽度百分比（0~100 的整数）；fill 为 null 时无意义。 */
  percent: number;
  /** 卡片右下角的 11px 小字；null 表示不显示（未到 90% 的进行中任务只有条、没有字）。 */
  note: string | null;
  /** 小字的语义档，决定颜色：near 用强调色、over 用危险色。 */
  noteKind: 'near' | 'over' | null;
  /** 完整文案，用作 title 与进度条的可访问名字。fill 为 null 时是空串。 */
  detail: string;
}

/** 判定需要的任务字段。BoardTask 与 TreeTask 都满足这个形状，所以两个界面共用这一份判定。 */
export interface ReminderInput {
  durationMinutes: number | null;
  spentMinutes: number;
  runningSince: string | null;
  columnId: string;
  archivedAt: string | null;
}

const MS_PER_MINUTE = 60_000;

/**
 * 「什么都不画」的那一档。除了完成列与归档任务，视图层也会直接用它：有子任务的父任务
 * 不显示工期提醒，而那个判断（是不是叶子）属于视图层——判定要用的字段里没有 childTotal。
 */
export const NO_REMINDER: ReminderView = {
  fill: null,
  percent: 0,
  note: null,
  noteKind: null,
  detail: '',
};

/**
 * 已用的分钟数：已结算的累计加上当前这一段。
 * 与后端 domain/clock.ts 的 elapsedMinutes 同一口径，同样是向下取整——
 * 取整方向不一致会让卡片上的「已用」比实际记账多一分钟。
 * 时刻无法解析或时钟回拨都只算已结算的部分，不倒扣。
 */
export function usedMinutes(task: ReminderInput, nowMs: number): number {
  if (task.runningSince === null) return task.spentMinutes;
  const ms = nowMs - Date.parse(task.runningSince);
  if (!Number.isFinite(ms) || ms <= 0) return task.spentMinutes;
  return task.spentMinutes + Math.floor(ms / MS_PER_MINUTE);
}

/**
 * 算出这个任务此刻的标记。
 *
 * 不提醒的情形：完成列与已归档（做完了的任务标「超期」没有意义，只占视觉）、
 * 未估工期（没有基准）、工期 0（瞬时任务没有可用的时间窗）。
 *
 * 提醒分两档，互斥且超期优先：
 * - `over`：已用达到或超过工期。**不区分是否在进行中**——停在待办但已用超过工期的任务
 *   照样标出来，那是一条事实，也是「当初估少了」的信号。
 * - `near`：正在计时且剩余不超过工期的 10%。停在待办的任务不会进入这一档：
 *   它没在消耗时间，「临近」无从谈起。
 *
 * 比较刻意用整数乘法（`剩余 × 10 ≤ 工期`）而不是浮点百分比，避免 10%T 在边界上
 * 出现 0.30000000000000004 这类误差。
 */
export function reminderView(task: ReminderInput, nowMs: number): ReminderView {
  if (task.columnId === DONE_COLUMN_ID || task.archivedAt !== null) return NO_REMINDER;

  const duration = task.durationMinutes;
  if (duration === null || duration <= 0) return NO_REMINDER;

  const used = usedMinutes(task, nowMs);
  const remaining = duration - used;
  const running = task.runningSince !== null;
  const over = remaining <= 0;
  const near = running && remaining * 10 <= duration;

  // 0 是边界上的常见值（已用正好等于工期），「超 0 分」读起来像出错，单独给一句话。
  const phrase = over
    ? remaining === 0
      ? '工期已用完'
      : `超 ${formatScheduleMinutes(-remaining)}`
    : `剩 ${formatScheduleMinutes(remaining)}`;

  return {
    fill: over ? 'over' : near ? 'near' : 'weak',
    percent: Math.min(Math.round((used / duration) * 100), 100),
    note: over || near ? phrase : null,
    noteKind: over ? 'over' : near ? 'near' : null,
    detail: `工期 ${formatScheduleMinutes(duration)}，已用 ${formatScheduleMinutes(used)}，${phrase}`,
  };
}
