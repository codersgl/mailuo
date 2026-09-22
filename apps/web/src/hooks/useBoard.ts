import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchBoard } from '../api/client';
import type { Board } from '../api/types';

/** 一次读取的三种状态。分开表达，组件里就不用判断「有数据但还是加载中」。 */
type BoardState =
  | { status: 'loading' }
  | { status: 'ready'; board: Board }
  | { status: 'failed'; message: string };

/**
 * 读某一层看板。parentId 为 null 时读根看板；导航做出来之前只会用到根看板。
 * 请求失败时把后端的中文错误文案原样带出来（见 src/api/client.ts）。
 */
export function useBoard(parentId: string | null) {
  const [state, setState] = useState<BoardState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // 组件卸载或 parentId 变了之后，旧请求的结果不能再写回状态。
    let cancelled = false;
    setState({ status: 'loading' });

    fetchBoard(parentId)
      .then((board) => {
        if (!cancelled) setState({ status: 'ready', board });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          status: 'failed',
          message: cause instanceof ApiError ? cause.message : '加载看板失败',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [parentId, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, reload };
}
