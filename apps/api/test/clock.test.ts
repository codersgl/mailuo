import { describe, expect, it } from 'vitest';
import { elapsedMinutes, settleClock, shouldRun } from '../src/domain/clock.js';

/** 固定基准时刻，所有用例从这里推，避免依赖真实时间。 */
const T0 = '2024-01-01T00:00:00.000Z';
/** T0 之后 minutes 分钟的时刻。 */
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

describe('shouldRun', () => {
  it('只有「进行中」且未归档的任务计时', () => {
    expect(shouldRun('doing', null)).toBe(true);
  });

  it('待办与完成列都不计时', () => {
    expect(shouldRun('todo', null)).toBe(false);
    expect(shouldRun('done', null)).toBe(false);
  });

  it('归档会盖过列：进行中的归档任务也不计时', () => {
    expect(shouldRun('doing', T0)).toBe(false);
  });
});

describe('elapsedMinutes', () => {
  it('整分钟精确计算', () => {
    expect(elapsedMinutes(T0, at(90))).toBe(90);
    expect(elapsedMinutes(T0, at(0))).toBe(0);
  });

  it('不足一分钟的零头向下取整，不四舍五入', () => {
    // 59.999 秒 → 0 分。取整方向是刻意的：宁可少算也不凭空多出一分钟。
    expect(elapsedMinutes(T0, new Date(Date.parse(T0) + 59_999).toISOString())).toBe(0);
    // 61 秒 → 1 分，多出的 1 秒不算。
    expect(elapsedMinutes(T0, new Date(Date.parse(T0) + 61_000).toISOString())).toBe(1);
  });

  it('时刻倒流（时钟回拨）按 0 处理，不倒扣已用时间', () => {
    expect(elapsedMinutes(at(10), T0)).toBe(0);
  });

  it('无法解析的时刻按 0 处理', () => {
    expect(elapsedMinutes('不是时间', T0)).toBe(0);
    expect(elapsedMinutes(T0, '不是时间')).toBe(0);
  });
});

describe('settleClock', () => {
  it('该跑且没在跑：记下这一段的开始时刻，已用不变', () => {
    const next = settleClock({ spentMinutes: 30, runningSince: null }, true, T0);
    expect(next).toEqual({ spentMinutes: 30, runningSince: T0 });
  });

  it('不该跑而在跑：把这一段结算进已用，并停表', () => {
    const next = settleClock({ spentMinutes: 30, runningSince: T0 }, false, at(45));
    expect(next).toEqual({ spentMinutes: 75, runningSince: null });
  });

  it('该跑且在跑：原样返回同一个对象，调用方据此不写库', () => {
    const clock = { spentMinutes: 30, runningSince: T0 };
    expect(settleClock(clock, true, at(45))).toBe(clock);
  });

  it('不该跑且没跑：同样原样返回同一个对象', () => {
    const clock = { spentMinutes: 30, runningSince: null };
    expect(settleClock(clock, false, at(45))).toBe(clock);
  });

  it('停两次不会重复结算', () => {
    const stopped = settleClock({ spentMinutes: 0, runningSince: T0 }, false, at(10));
    expect(settleClock(stopped, false, at(20))).toBe(stopped);
  });

  it('停表后再开工，已用继续累计而不是从零开始', () => {
    const first = settleClock({ spentMinutes: 0, runningSince: T0 }, false, at(10));
    const second = settleClock(first, true, at(20));
    const third = settleClock(second, false, at(35));

    expect(second.runningSince).toBe(at(20));
    expect(third).toEqual({ spentMinutes: 25, runningSince: null });
  });
});
