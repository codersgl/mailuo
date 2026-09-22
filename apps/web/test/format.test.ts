import { describe, expect, it } from 'vitest';
import {
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  formatDuration,
  formatProgress,
  isDurationEstimated,
  progressPercent,
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
