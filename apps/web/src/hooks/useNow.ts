import { useEffect, useState } from 'react';

/** 默认刷新间隔：半分钟。工期以分钟为刻度，再密只是白重渲染。 */
export const DEFAULT_NOW_INTERVAL_MS = 30_000;

/**
 * 会自己往前走的「现在」。
 *
 * 工期提醒（见 domain/reminder.ts）依赖当前时刻：一个进行中的任务会在页面开着的时候
 * 从「未到 90%」走到「临近」再走到「超期」。没有这个 tick，界面会一直停在打开页面
 * 那一刻算出的标记上，直到下一次取数。
 *
 * 只在对数据敏感的那两个视图各挂一个（看板与任务树），而不是在每张卡片里各挂一个：
 * 卡片数量是任务数量级的，那样会有几十个定时器做同一件事。
 *
 * 传 `intervalMs` 为 null 可以关掉重渲染（用例里想要一个钉死的时刻时用）。
 */
export function useNow(intervalMs: number | null = DEFAULT_NOW_INTERVAL_MS): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (intervalMs === null) return;
    const id = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return nowMs;
}
