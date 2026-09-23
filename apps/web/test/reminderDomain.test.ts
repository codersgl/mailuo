import { describe, expect, it } from 'vitest';
import { reminderView, usedMinutes } from '../src/domain/reminder';
import type { ReminderInput } from '../src/domain/reminder';

/** 固定基准时刻，所有用例从这里推，避免依赖真实时间。 */
const T0 = '2024-01-01T00:00:00.000Z';
const T0_MS = Date.parse(T0);
/** T0 之后 minutes 分钟的时刻（毫秒）。 */
const at = (minutes: number) => T0_MS + minutes * 60_000;

/** 造一个「进行中、工期 1 天（480 分）」的任务，各用例只覆盖自己关心的字段。 */
function task(overrides: Partial<ReminderInput> = {}): ReminderInput {
  return {
    durationMinutes: 480,
    spentMinutes: 0,
    runningSince: null,
    columnId: 'doing',
    archivedAt: null,
    ...overrides,
  };
}

describe('usedMinutes', () => {
  it('没在计时就只算已结算的部分', () => {
    expect(usedMinutes(task({ spentMinutes: 120, runningSince: null }), at(999))).toBe(120);
  });

  it('在计时就把这一段加上，零头向下取整', () => {
    // 从 T0 跑 90.5 分钟 → 90 分（与后端 domain/clock.ts 的 elapsedMinutes 同一方向）。
    expect(usedMinutes(task({ spentMinutes: 30, runningSince: T0 }), at(90) + 30_000)).toBe(120);
  });

  it('时刻倒流（时钟回拨）不倒扣已结算的用时', () => {
    expect(usedMinutes(task({ spentMinutes: 30, runningSince: new Date(at(10)).toISOString() }), T0_MS)).toBe(30);
  });

  it('无法解析的开始时刻只算已结算的部分', () => {
    expect(usedMinutes(task({ spentMinutes: 30, runningSince: '不是时间' }), T0_MS)).toBe(30);
  });
});

describe('reminderView 的不提醒情形', () => {
  it('未估工期不画条也不给字', () => {
    expect(reminderView(task({ durationMinutes: null }), at(0)).fill).toBeNull();
  });

  it('工期 0（瞬时任务）不提醒', () => {
    expect(reminderView(task({ durationMinutes: 0 }), at(9999)).fill).toBeNull();
  });

  it('完成列不提醒，哪怕早就超期', () => {
    const view = reminderView(task({ columnId: 'done', spentMinutes: 9999 }), at(0));
    expect(view.fill).toBeNull();
    expect(view.note).toBeNull();
  });

  it('已归档任务不提醒', () => {
    expect(reminderView(task({ archivedAt: T0, spentMinutes: 9999 }), at(0)).fill).toBeNull();
  });
});

describe('reminderView 的临近判定', () => {
  it('停着不动的任务即使剩余不足 10%T 也只算弱填充：临近要求正在计时', () => {
    // 工期 480，已用 432，剩 48 = 10%T，但没在跑，所以不进临近档。
    const view = reminderView(task({ spentMinutes: 432, runningSince: null }), at(0));
    expect(view.fill).toBe('weak');
  });

  it('正在计时且剩余恰好 10%T 时算临近', () => {
    const view = reminderView(task({ spentMinutes: 432, runningSince: T0 }), at(0));
    expect(view.fill).toBe('near');
    expect(view.note).toBe('剩 48 分');
    expect(view.noteKind).toBe('near');
  });

  it('剩余比 10%T 多一分钟就不算临近，只剩一条弱填充的条', () => {
    const view = reminderView(task({ spentMinutes: 431, runningSince: T0 }), at(0));
    expect(view.fill).toBe('weak');
    expect(view.note).toBeNull();
    expect(view.noteKind).toBeNull();
    // 条本身仍然带着完整信息（这一步没有可见文字，读屏只能靠它）。
    expect(view.detail).toContain('剩 49 分');
  });

  it('停在待办的任务不会进入临近档：它没在消耗时间', () => {
    const view = reminderView(task({ columnId: 'todo', spentMinutes: 470, runningSince: null }), at(0));
    expect(view.fill).toBe('weak');
    expect(view.note).toBeNull();
  });
});

describe('reminderView 的超期判定', () => {
  it('已用超过工期算超期，小字说超了多久', () => {
    // 工期 480，已用 660 → 超 180 分 = 3 小时。
    const view = reminderView(task({ spentMinutes: 660, runningSince: null }), at(0));
    expect(view.fill).toBe('over');
    expect(view.note).toBe('超 3 小时');
    expect(view.noteKind).toBe('over');
    expect(view.percent).toBe(100);
  });

  it('停在待办但已超期同样标出来（不区分是否在计时）', () => {
    const view = reminderView(
      task({ columnId: 'todo', durationMinutes: 144, spentMinutes: 300, runningSince: null }),
      at(0),
    );
    expect(view.fill).toBe('over');
    expect(view.note).toBe('超 2 小时 36 分');
  });

  it('已用正好等于工期：边界上给一句话，不写「超 0 分」', () => {
    const view = reminderView(task({ spentMinutes: 480, runningSince: null }), at(0));
    expect(view.fill).toBe('over');
    expect(view.note).toBe('工期已用完');
    expect(view.detail).toContain('工期已用完');
  });

  it('超期优先于临近', () => {
    const view = reminderView(task({ spentMinutes: 500, runningSince: T0 }), at(0));
    expect(view.fill).toBe('over');
    expect(view.noteKind).toBe('over');
  });
});

describe('reminderView 的进度比例与文案', () => {
  it('比例按 已用 / 工期 取整，封顶 100', () => {
    expect(reminderView(task({ spentMinutes: 240 }), at(0)).percent).toBe(50);
    // 480 的三分之一是 160 → 33.33% → 33。
    expect(reminderView(task({ durationMinutes: 480, spentMinutes: 160 }), at(0)).percent).toBe(33);
    expect(reminderView(task({ spentMinutes: 9999 }), at(0)).percent).toBe(100);
  });

  it('完整文案用 groupMinutes 口径（1 天 = 480 分）', () => {
    const view = reminderView(task({ durationMinutes: 480, spentMinutes: 420, runningSince: null }), at(0));
    expect(view.detail).toBe('工期 1 天，已用 7 小时，剩 1 小时');
  });

  it('时刻往前走会自己从弱填充走到临近再到超期', () => {
    const running = task({ runningSince: T0 });
    expect(reminderView(running, at(100)).fill).toBe('weak'); // 剩 380 分
    expect(reminderView(running, at(432)).fill).toBe('near'); // 剩 48 分
    expect(reminderView(running, at(500)).fill).toBe('over'); // 超 20 分
  });
});
