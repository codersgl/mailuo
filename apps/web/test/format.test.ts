import { describe, expect, it } from 'vitest';
import {
  MAX_DURATION_MINUTES,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  formatDuration,
  formatProgress,
  isDurationEstimated,
  progressPercent,
  readDurationInput,
  splitDuration,
} from '../src/lib/format';

describe('formatDuration', () => {
  it('null 表示未估工期', () => {
    expect(formatDuration(null)).toBe('未估工期');
    expect(isDurationEstimated(null)).toBe(false);
  });

  it('0 表示瞬时任务，和未估是两种状态', () => {
    expect(formatDuration(0)).toBe('瞬时');
    expect(isDurationEstimated(0)).toBe(true);
  });

  it('不到一小时只显示分钟', () => {
    expect(formatDuration(1)).toBe('工期 1 分');
    expect(formatDuration(45)).toBe('工期 45 分');
  });

  it('不到一天按小时和分钟组合', () => {
    expect(formatDuration(MINUTES_PER_HOUR)).toBe('工期 1 小时');
    expect(formatDuration(90)).toBe('工期 1 小时 30 分');
    expect(formatDuration(MINUTES_PER_DAY - 1)).toBe('工期 7 小时 59 分');
  });

  it('一天以上按天、小时、分钟组合，只保留非零部分', () => {
    expect(formatDuration(MINUTES_PER_DAY)).toBe('工期 1 天');
    expect(formatDuration(MINUTES_PER_DAY + 60)).toBe('工期 1 天 1 小时');
    expect(formatDuration(MINUTES_PER_DAY + 65)).toBe('工期 1 天 1 小时 5 分');
    expect(formatDuration(4320)).toBe('工期 9 天');
  });

  it('契约外的负数兜底按瞬时处理，不显示负工期', () => {
    expect(formatDuration(-1)).toBe('瞬时');
  });
});

describe('formatProgress', () => {
  it('按 完成/总数 展示，没有子任务时是 0/0', () => {
    expect(formatProgress(1, 2)).toBe('1/2 子任务');
    expect(formatProgress(0, 0)).toBe('0/0 子任务');
  });
});

describe('progressPercent', () => {
  it('四舍五入到整数百分比', () => {
    expect(progressPercent(1, 3)).toBe(33);
    expect(progressPercent(2, 3)).toBe(67);
    expect(progressPercent(2, 2)).toBe(100);
  });

  it('没有子任务时返回 0，不出现除零或 NaN', () => {
    expect(progressPercent(0, 0)).toBe(0);
  });

  it('契约外的负数总数同样返回 0，不出现 -0 或负数宽度', () => {
    expect(progressPercent(0, -1)).toBe(0);
  });
});

describe('工期输入的三段换算', () => {
  it('已有工期拆成天 / 小时 / 分，为零的那段留空', () => {
    expect(splitDuration(1920)).toEqual({ days: '4', hours: '', minutes: '' });
    expect(splitDuration(1470)).toEqual({ days: '3', hours: '', minutes: '30' });
    expect(splitDuration(MINUTES_PER_DAY + 65)).toEqual({
      days: '1',
      hours: '1',
      minutes: '5',
    });
  });

  it('未估拆成全空，瞬时落到分钟段上：两者必须在界面上分得开', () => {
    expect(splitDuration(null)).toEqual({ days: '', hours: '', minutes: '' });
    expect(splitDuration(0)).toEqual({ days: '', hours: '', minutes: '0' });
  });

  it('三段全空读成未估', () => {
    expect(readDurationInput({ days: '', hours: '', minutes: '' })).toEqual({ kind: 'unset' });
    expect(readDurationInput({ days: ' ', hours: '', minutes: '' })).toEqual({ kind: 'unset' });
  });

  it('填了 0 就是瞬时，不能和未估混为一谈', () => {
    expect(readDurationInput({ days: '', hours: '', minutes: '0' })).toEqual({
      kind: 'minutes',
      value: 0,
    });
    expect(readDurationInput({ days: '0', hours: '', minutes: '' })).toEqual({
      kind: 'minutes',
      value: 0,
    });
  });

  it('按 1 天 = 480 分钟、1 小时 = 60 分钟求和', () => {
    expect(readDurationInput({ days: '2', hours: '4', minutes: '30' })).toEqual({
      kind: 'minutes',
      value: 2 * MINUTES_PER_DAY + 4 * MINUTES_PER_HOUR + 30,
    });
  });

  it('非整数、负数、科学计数法都算非法，而不是被 parseInt 悄悄截断', () => {
    expect(readDurationInput({ days: '1.5', hours: '', minutes: '' })).toEqual({ kind: 'invalid' });
    expect(readDurationInput({ days: '-1', hours: '', minutes: '' })).toEqual({ kind: 'invalid' });
    expect(readDurationInput({ days: '1e3', hours: '', minutes: '' })).toEqual({ kind: 'invalid' });
  });

  it('拆分与求和互为逆运算', () => {
    for (const minutes of [0, 1, 59, 60, 479, 480, 1470, 1920, 4320]) {
      const parts = splitDuration(minutes);
      expect(readDurationInput(parts)).toEqual({ kind: 'minutes', value: minutes });
    }
  });

  it('超过上限一律算非法：否则后端会 500，或者 Infinity 被 JSON 变成 null 静默存成未估', () => {
    expect(readDurationInput({ days: '10000000000000000000', hours: '', minutes: '' })).toEqual({
      kind: 'invalid',
    });
    expect(readDurationInput({ days: '9'.repeat(400), hours: '', minutes: '' })).toEqual({
      kind: 'invalid',
    });
    // 上限本身可用，再大一天就拒。
    expect(readDurationInput({ days: '9999', hours: '', minutes: '' })).toEqual({
      kind: 'minutes',
      value: MAX_DURATION_MINUTES,
    });
    expect(readDurationInput({ days: '10000', hours: '', minutes: '' })).toEqual({ kind: 'invalid' });
  });
});

