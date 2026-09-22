import { useCallback, useEffect, useState } from 'react';
import type { DependencyList } from 'react';
import { ApiError } from '../api/client';

/** 一次读取的三种状态。分开表达，组件里就不用判断「有数据但还是加载中」。 */
export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; message: string };

export interface AsyncResult<T> {
  state: AsyncState<T>;
  /** 手动重取。失败态的重试按钮用它。 */
  reload: () => void;
}

/**
 * 「取一次数据」这件事的公共部分：三种状态、失败时带出后端的中文文案、过期响应丢弃、重试。
 * 看板、文件树、面包屑三处读取形状完全一样，各自再写一遍只会让竞态守卫出现三份。
 *
 * `deps` 决定「什么时候该重取」，语义同 `useEffect` 的依赖数组。`load` 每次渲染都是新函数，
 * 故意不放进依赖里：调用方必须把 load 里用到的入参列进 deps，否则会读到上一次闭包的值。
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: DependencyList,
  fallbackMessage: string,
): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // 组件卸载、依赖变化、点重试之后，旧请求的结果都不能再写回状态。
    let cancelled = false;
    setState({ status: 'loading' });

    load()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // 非 ApiError 只可能是代码 bug（client 已经把网络失败包成 ApiError），给个兜底文案即可。
        setState({
          status: 'failed',
          message: cause instanceof ApiError ? cause.message : fallbackMessage,
        });
      });

    return () => {
      cancelled = true;
    };
    // 依赖数组由调用方通过 deps 传入，这里刻意不列 load。
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, reload };
}
