import { describe, expect, it } from 'vitest';
import { formatDuration, formatProgress, isDurationEstimated, progressPercent } from '../src/lib/format';

describe('formatDuration', () => {
  it('工期为 0 时显示未估工期，而不是 0 天', () => {
    expect(formatDuration(0)).toBe('未估工期');
    expect(isDurationEstimated(0)).toBe(false);
  });

  it('有工期时带上单位', () => {
    expect(formatDuration(1)).toBe('工期 1 天');
    expect(formatDuration(5)).toBe('工期 5 天');
    expect(isDurationEstimated(5)).toBe(true);
  });

  it('契约外的负数也按未估工期处理，不显示「工期 -1 天」', () => {
    expect(formatDuration(-1)).toBe('未估工期');
    expect(isDurationEstimated(-1)).toBe(false);
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
