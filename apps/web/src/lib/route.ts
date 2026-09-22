/**
 * 路由形状只有两种（见 docs/spec.md 的「界面行为」）：
 * 根看板是 `/`，某个任务的看板是 `/board/:taskId`。
 * 解析与拼装是纯函数，放在这里方便单独测；与浏览器历史的对接在 hooks/useRoute.ts。
 */

export type Route =
  | { kind: 'board'; boardId: string | null }
  /** pathname 带出来，好让「地址认不出来」那张页面显示用户输的原文，不用在组件里读全局。 */
  | { kind: 'notFound'; pathname: string };

/**
 * 把 `location.pathname` 变成路由。认不出的路径返回 notFound 而不是退回根看板：
 * 地址栏停在 `/nonsense` 却显示根看板会让人以为这个地址有效。
 */
export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { kind: 'board', boardId: null };

  // 结尾多一个斜杠也接受（`/board/abc/`），手输地址时很常见。
  const matched = /^\/board\/([^/]+)\/?$/.exec(pathname);
  if (!matched) return { kind: 'notFound', pathname };

  try {
    // 与 boardPath 的 encodeURIComponent 对称。非法百分号编码（`/board/%`）会抛错。
    return { kind: 'board', boardId: decodeURIComponent(matched[1]!) };
  } catch {
    return { kind: 'notFound', pathname };
  }
}

/** 路由 → 路径。看板 id 是后端生成的 UUID，encode 只是为了让拼装与解析严格对称。 */
export function boardPath(boardId: string | null): string {
  return boardId === null ? '/' : `/board/${encodeURIComponent(boardId)}`;
}
