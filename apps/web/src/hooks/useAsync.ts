import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyList } from 'react';
import { ApiError } from '../api/client';

/** 一次读取的三种状态。分开表达，组件里就不用判断「有数据但还是加载中」。 */
export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; message: string };

export interface AsyncResult<T> {
  state: AsyncState<T>;
  /** 显示加载态的重取。失败态的重试按钮用它。 */
  reload: () => void;
  /**
   * 静默重取：保留当前数据继续显示，拿到新数据后替换。写操作成功后用它刷新，
   * 否则一次改标题会让整块看板退回「加载中」闪一下。
   */
  refresh: () => void;
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
  // refresh() 置上这个标记，effect 读到后跳过「清空数据」这一步。用 ref 而不是 state：
  // 它只在「这一轮 effect 是怎么被触发的」这件事上有意义，不该引起额外渲染。
  const quiet = useRef(false);
  // 上一轮的 deps，用来分辨这次 effect 是「同一份数据重取」还是「换了一份数据」。
  const previousDeps = useRef<DependencyList | null>(null);

  useEffect(() => {
    // 组件卸载、依赖变化、点重试之后，旧请求的结果都不能再写回状态。
    let cancelled = false;

    const previous = previousDeps.current;
    const depsChanged =
      previous === null ||
      previous.length !== deps.length ||
      deps.some((value, index) => !Object.is(value, previous[index]));
    previousDeps.current = [...deps];

    // deps 变了说明要展示的是另一份数据，必须回到 loading。静默重取只对「同一份数据」成立：
    // 若 refresh 恰好和 deps 变化撞在一起（写成功的同时切了看板），按非静默处理。
    const isQuiet = quiet.current && !depsChanged;
    quiet.current = false;
    if (!isQuiet) setState({ status: 'loading' });

    load()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // 非 ApiError 只可能是代码 bug（client 已经把网络失败包成 ApiError），给个兜底文案即可。
        const message = cause instanceof ApiError ? cause.message : fallbackMessage;
        // 静默重取失败时保留已经显示出来的数据：写操作本身成功了，一次后台刷新失败
        // 不该把可用的界面换成错误页。
        setState((previous) =>
          isQuiet && previous.status === 'ready' ? previous : { status: 'failed', message },
        );
      });

    return () => {
      cancelled = true;
    };
    // 依赖数组由调用方通过 deps 传入，这里刻意不列 load。
  }, [...deps, attempt]);

  const reload = useCallback(() => {
    // 响亮重取：顺手清掉可能还留着的静默标记。否则同一批里先 refresh() 再 reload()，
    // 这一轮会被当成静默，重试按钮点下去看不到加载态。
    quiet.current = false;
    setAttempt((value) => value + 1);
  }, []);

  const refresh = useCallback(() => {
    quiet.current = true;
    setAttempt((value) => value + 1);
  }, []);

  return { state, reload, refresh };
}
