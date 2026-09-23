import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchSearch } from '../api/client';
import type { ColumnRecord, SearchResult } from '../api/types';

/**
 * 输入停顿多久才发请求。打字过程中每个字符都发一次请求的话，本地库虽然扛得住，
 * 但结果列表会随每次击键跳一遍；200ms 是「停手就出结果」与「不中途乱跳」之间的常用取值。
 */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * 搜索的四种状态。
 *
 * 没有 `pending` 字段：正在飞的那一次请求不需要界面知道。已经有结果时继续显示上一批，
 * 新结果到了直接替换——打字时每停顿一下就把列表清空会很跳，而本机请求只要几毫秒，
 * 根本来不及显示「搜索中」。
 *
 * `ready` 里必须记住**这批结果属于哪一次搜索**（`keyword` 与 `includeArchived`）：回调一到就把
 * 结果写进 state，而输入框与开关可能已经又变了。界面用它来高亮、写空状态文案，BoardPage 用它
 * 判断「这次 Enter 该不该动作」。少了 keyword，防抖窗口内按 Enter 会打开上一个关键词的结果，
 * 旧结果也会被新词重新高亮成「标黄的词并不匹配这一行」；少了 includeArchived，切开关后的
 * 200ms 里空状态会按新开关说话（说「打开显示已归档试试」而开关已经开了）。
 */
export type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready';
      keyword: string;
      includeArchived: boolean;
      columns: ColumnRecord[];
      results: SearchResult[];
      truncated: boolean;
    }
  | { status: 'failed'; message: string };

export interface SearchHandle {
  state: SearchState;
  /** 失败态的重试按钮用它：关键词与开关不变，重取同一份。 */
  retry: () => void;
}

/**
 * 按关键词搜索全库任务。
 *
 * 关键词为空（去掉两端空白后）时不发请求，直接回到 idle：空词匹配一切，
 * 把整个库倒出来既没有用，也会让「清空搜索框」变成一个昂贵的操作。
 * 关键词或「显示已归档」开关变化都会重取，晚到的响应按 `cancelled` 丢弃。
 */
export function useSearch(keyword: string, includeArchived: boolean): SearchHandle {
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const trimmed = keyword.trim();
    if (trimmed === '') {
      setState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    // 已经有结果就保持 ready，别退回 loading（见 SearchState 的说明）。
    setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));

    const timer = setTimeout(() => {
      fetchSearch(trimmed, includeArchived)
        .then((data) => {
          if (!cancelled) setState({ status: 'ready', keyword: trimmed, includeArchived, ...data });
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setState({
            status: 'failed',
            message: cause instanceof ApiError ? cause.message : '搜索失败',
          });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [keyword, includeArchived, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, retry };
}
