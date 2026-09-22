import { useCallback, useEffect, useState } from 'react';
import { boardPath, parseRoute } from '../lib/route';
import type { Route } from '../lib/route';

/**
 * 把当前 URL 变成 React state，并提供 navigate()。
 *
 * 不引入路由库：只有两种路径形状（见 lib/route.ts），路由库带来的嵌套路由、loader、
 * 数据 API 都用不上，而它自己的匹配语义还要额外学一遍。这里是 30 行的直接实现。
 */
export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    // 后退/前进只改 URL、不重新挂载组件，得自己把 URL 同步回 state。
    const sync = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  /** replace 用于「从坏地址回根看板」：坏地址不该留在历史里等着被后退回来。 */
  const navigate = useCallback((boardId: string | null, options?: { replace?: boolean }) => {
    const path = boardPath(boardId);
    // 比较前先规范化：手输过的 `/board/a/` 与 `/board/a` 是同一层，
    // 不规范化就会多压一条历史（正是下面这行想避免的症状）。
    if (path === normalizePath(window.location.pathname)) return;

    if (options?.replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setRoute(parseRoute(path));
  }, []);

  return { route, navigate };
}

/** 认不出的路径原样返回：它没有规范化形式，只用于和拼出来的路径比较。 */
function normalizePath(pathname: string): string {
  const route = parseRoute(pathname);
  return route.kind === 'board' ? boardPath(route.boardId) : pathname;
}
