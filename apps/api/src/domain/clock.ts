import { DOING_COLUMN_ID } from './columns.js';

/**
 * 工期计时：只累加任务待在「进行中」列里的时间（见 docs/spec.md 的「工期提醒」）。
 *
 * 状态拆成两列存：
 *   spent_minutes  已结算的累计用时（分钟）
 *   running_since  当前这一段的开始时刻；非空表示正在计时
 *
 * 不变式：running_since IS NOT NULL  ⟺  (column_id = 'doing' AND archived_at IS NULL AND 是叶子)。
 * 仓储层每个会改到列或归档状态的写入口，最后都走 reconcileDerivedStatus 维持它；
 * 恢复归档这种「绕过结算直接改行」的路径，也由它补上 running_since。
 * 测试直接按这条不变式断言，而不是逐条断言调用点。
 *
 * 这里刻意**只做计时，不做提醒判定**。「临近 / 超期」是随时间的流逝自己会变的状态，
 * 前端必须在两次取数之间用本地的 now 重算，后端再算一份就是两处实现，迟早分叉
 * （D50 为「关键边判定」记过同样的教训）。后端只负责把事实存准：工期、已用、这段何时开始。
 */
export interface TaskClock {
  spentMinutes: number;
  runningSince: string | null;
}

/** 以毫秒为单位的分钟数。 */
const MS_PER_MINUTE = 60_000;

/**
 * 该不该计时：只有未归档、处在「进行中」列、且是叶子（没有未归档子任务）的任务在跑。
 *
 * 父任务不走表是有意的。它的列由子任务推导（见 domain/derive.ts），只要子树里有活在干，
 * 它就一直是「进行中」——让它跟着走表，项目根会把整棵子树的干活时间都记在自己头上，
 * 而它自己的工期估算与那个数字无法对照（一个 5 天的项目，子任务干了一周它就「超期 7 天」）。
 * 父任务的时间要表达的是「这个分支投入了多少」，那要从叶子汇总，不是自己计时。
 */
export function shouldRun(
  columnId: string,
  archivedAt: string | null,
  isLeaf: boolean,
): boolean {
  return isLeaf && columnId === DOING_COLUMN_ID && archivedAt === null;
}

/**
 * 一段时长的分钟数，向下取整。
 *
 * 取整方向是刻意选的：工期以分钟为刻度，宁可少算也不要凭空多出一分钟。
 * 代价是反复进出「进行中」时，每次不足一分钟的零头都会丢——一个人手动拖动卡片，
 * 单段零头只可能是秒级，累积误差远小于工期估算本身的误差，不值得为它存秒。
 *
 * 时刻无法解析或发生时钟回拨（now 早于 since）都按 0 处理，不让它倒扣已用时间。
 */
export function elapsedMinutes(since: string, now: string): number {
  const ms = Date.parse(now) - Date.parse(since);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / MS_PER_MINUTE);
}

/**
 * 让计时状态跟上「现在该不该跑」，返回新状态。
 * 状态没变时原样返回同一个对象，调用方据此判断「不用写库」。
 *
 * 三种情形：该跑且没在跑 → 开一段新的；不该跑而在跑 → 把这一段结算进 spent_minutes；
 * 其余（该跑且在跑、不该跑且没跑）→ 不动。所以同一个任务连续两次进入「进行中」不会重置计时，
 * 连续两次离开也不会重复结算。
 */
export function settleClock(clock: TaskClock, run: boolean, now: string): TaskClock {
  const running = clock.runningSince !== null;
  if (run === running) return clock;
  if (run) return { spentMinutes: clock.spentMinutes, runningSince: now };
  return {
    spentMinutes: clock.spentMinutes + elapsedMinutes(clock.runningSince ?? now, now),
    runningSince: null,
  };
}
