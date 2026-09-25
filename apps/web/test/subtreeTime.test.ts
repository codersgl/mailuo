import { describe, expect, it } from 'vitest';
import { branchView, buildSubtreeTimes, subtreeUsedMinutes } from '../src/domain/subtreeTime';
import { NO_REMINDER } from '../src/domain/reminder';
import type { TreeTask } from '../src/api/types';

/**
 * 子树时间汇总的口径（见 docs/decisions.md D77）：
 * 父任务不画自己的工期，画的是「Σ 未归档叶子已用 / Σ 未归档叶子工期」；
 * 只要有一片叶子未估工期，分母就不可信，只报已用。
 *
 * 这里只测纯函数。它在界面上的样子（胶囊、条、树上的比例与「未估」标记）在 reminderUi.test.tsx，
 * 「BoardPage 有没有把这张表交给卡片」在 App.test.tsx。
 */

const T0 = '2024-01-01T00:00:00.000Z';
const T0_MS = Date.parse(T0);
const MINUTE_MS = 60_000;

/** 造一个树任务。默认待办列、未归档、未估工期、没在跑，只在用例需要时覆盖。 */
function task(id: string, parentId: string | null, overrides: Partial<TreeTask> = {}): TreeTask {
  return {
    id,
    parentId,
    title: id,
    columnId: 'todo',
    archivedAt: null,
    durationMinutes: null,
    spentMinutes: 0,
    runningSince: null,
    ...overrides,
  };
}

describe('buildSubtreeTimes', () => {
  it('汇总的是子树里的叶子，不是直接子任务', () => {
    // root ─ mid ─ leaf1
    //      └ leaf2
    // 「mid 自己的时间」不该进 root 的和，进去的只能是两片叶子。
    const times = buildSubtreeTimes([
      task('root', null, { durationMinutes: 9999, spentMinutes: 9999 }),
      task('mid', 'root', { durationMinutes: 9999, spentMinutes: 9999 }),
      task('leaf1', 'mid', { durationMinutes: 480, spentMinutes: 120 }),
      task('leaf2', 'root', { durationMinutes: 240, spentMinutes: 60 }),
    ]);

    expect(times.get('root')).toEqual({
      leafCount: 2,
      spentMinutes: 180,
      runningSince: [],
      durationMinutes: 720,
    });
    expect(times.get('mid')).toEqual({
      leafCount: 1,
      spentMinutes: 120,
      runningSince: [],
      durationMinutes: 480,
    });
    // 叶子自己的条目是空的：它要的子任务一个都没有（它自己的时间由它自己那条提醒表达）。
    expect(times.get('leaf1')).toEqual({
      leafCount: 0,
      spentMinutes: 0,
      runningSince: [],
      durationMinutes: 0,
    });
  });

  it('有一片叶子未估工期，整个分母就是未估，但已用照常累加', () => {
    const times = buildSubtreeTimes([
      task('root', null),
      task('leaf1', 'root', { durationMinutes: 480, spentMinutes: 120 }),
      task('leaf2', 'root', { durationMinutes: null, spentMinutes: 60 }),
    ]);

    expect(times.get('root')).toEqual({
      leafCount: 2,
      spentMinutes: 180,
      runningSince: [],
      // 不是把未估当 0 加出 480——那会让比率随着这片叶子干活自己往上飘。
      durationMinutes: null,
    });
  });

  it('已归档的整支都不算：归档的叶子不进分母也不进分子', () => {
    const times = buildSubtreeTimes([
      task('root', null),
      task('leaf1', 'root', { durationMinutes: 480, spentMinutes: 120 }),
      task('leaf2', 'root', {
        durationMinutes: 240,
        spentMinutes: 60,
        archivedAt: T0,
      }),
    ]);

    expect(times.get('root')).toEqual({
      leafCount: 1,
      spentMinutes: 120,
      runningSince: [],
      durationMinutes: 480,
    });
  });

  it('正在跑的叶子只记下开始时刻，分钟数按调用方的 now 现算', () => {
    const times = buildSubtreeTimes([
      task('root', null),
      task('leaf', 'root', { durationMinutes: 60, spentMinutes: 10, runningSince: T0 }),
    ]);
    const root = times.get('root')!;

    expect(root.runningSince).toEqual([T0]);
    expect(subtreeUsedMinutes(root, T0_MS)).toBe(10);
    expect(subtreeUsedMinutes(root, T0_MS + 5 * MINUTE_MS)).toBe(15);
    // 时钟回拨（now 早于开始时刻）不倒扣已结算的那部分。
    expect(subtreeUsedMinutes(root, T0_MS - 5 * MINUTE_MS)).toBe(10);
  });

  it('每片在跑的叶子各算一段再相加，取整与单片的算法一致', () => {
    const times = buildSubtreeTimes([
      task('root', null),
      task('a', 'root', { durationMinutes: 60, runningSince: T0 }),
      task('b', 'root', { durationMinutes: 60, runningSince: T0 }),
    ]);
    const root = times.get('root')!;

    // 各 90 秒：分别向下取整是 1 分 + 1 分，而不是 (90+90) 秒整成 3 分。
    expect(subtreeUsedMinutes(root, T0_MS + 90_000)).toBe(2);
  });

  it('成环的脏数据不吃掉进程，环上那两个不参与汇总，结果与输入顺序无关', () => {
    // a.parent = b、b.parent = a，c 挂在 a 下面。手工改库才可能造出来（接口层挡住了）。
    const cyclic = [task('a', 'b'), task('b', 'a'), task('c', 'a', { durationMinutes: 60 })];
    const one = buildSubtreeTimes(cyclic);
    const two = buildSubtreeTimes([cyclic[1]!, cyclic[0]!, cyclic[2]!]);

    // 环上那两个无法定义「子树里的叶子」，整批剔出去；挂在环下面的 c 照常有条目。
    expect(one.has('a')).toBe(false);
    expect(one.has('b')).toBe(false);
    expect(one.get('c')).toEqual({
      leafCount: 0,
      spentMinutes: 0,
      runningSince: [],
      durationMinutes: 0,
    });
    expect([...two.entries()]).toEqual([...one.entries()]);
  });
});

describe('branchView', () => {
  it('全部叶子都估了：给分数、给条，Σ 的口径写在完整文案里', () => {
    const view = branchView(
      { leafCount: 2, spentMinutes: 180, runningSince: [], durationMinutes: 720 },
      { columnId: 'doing', archivedAt: null },
      T0_MS,
    );

    expect(view.capsule).toBe('已用 3 小时 / 1 天 4 小时');
    expect(view.estimated).toBe(true);
    expect(view.reminder.fill).toBe('weak');
    // 「Σ 是工作量，不是日历工期」必须写在文案里，否则这两个数会被当成日历工期读。
    expect(view.detail).toContain('工作量口径');
    expect(view.detail).toContain('子树 2 个未归档叶子：Σ已用 3 小时');
  });

  it('有叶子未估：只说已用，不画条也不给临近/超期', () => {
    const view = branchView(
      { leafCount: 2, spentMinutes: 180, runningSince: [], durationMinutes: null },
      { columnId: 'doing', archivedAt: null },
      T0_MS,
    );

    expect(view.capsule).toBe('已用 3 小时 / 未估');
    expect(view.estimated).toBe(false);
    expect(view.reminder).toBe(NO_REMINDER);
    expect(view.detail).toContain('没有可信的分母');
  });

  it('有叶子在跑才算「临近」：不在跑时剩余再少也只是弱填充', () => {
    const stopped = branchView(
      { leafCount: 1, spentMinutes: 55, runningSince: [], durationMinutes: 60 },
      { columnId: 'doing', archivedAt: null },
      T0_MS,
    );
    expect(stopped.reminder.fill).toBe('weak');
    expect(stopped.reminder.note).toBeNull();

    const running = branchView(
      { leafCount: 1, spentMinutes: 55, runningSince: [T0], durationMinutes: 60 },
      { columnId: 'doing', archivedAt: null },
      T0_MS,
    );
    expect(running.reminder.fill).toBe('near');
    expect(running.reminder.note).toBe('剩 5 分');
  });

  it('完成列与已归档的父任务照画胶囊，但不给条与小字', () => {
    const done = branchView(
      { leafCount: 1, spentMinutes: 90, runningSince: [], durationMinutes: 120 },
      { columnId: 'done', archivedAt: null },
      T0_MS,
    );

    expect(done.capsule).toBe('已用 1 小时 30 分 / 2 小时');
    expect(done.reminder).toBe(NO_REMINDER);
  });

  it('Σ 工期为 0（全是瞬时叶子）：只报数字，没有时间窗', () => {
    const view = branchView(
      { leafCount: 2, spentMinutes: 30, runningSince: [], durationMinutes: 0 },
      { columnId: 'doing', archivedAt: null },
      T0_MS,
    );

    expect(view.capsule).toBe('已用 30 分 / 瞬时');
    expect(view.estimated).toBe(true);
    expect(view.reminder).toBe(NO_REMINDER);
  });
});
