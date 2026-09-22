import type { Board, BreadcrumbItem, TreeTask } from './types';

/**
 * 后端错误统一是 `{ error: string }`（见 docs/spec.md），这里把它变成异常，
 * 让调用方只处理一种失败形式：`error.message` 就是可以直接显示给用户的中文文案。
 */
export class ApiError extends Error {
  constructor(
    /** HTTP 状态码；0 表示请求根本没发出去（后端没启动）。 */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 开发时走 Vite 的代理，生产同源部署，所以路径里不写主机与端口。 */
async function request<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError(0, '连不上后端，确认 `pnpm dev:api` 已经启动');
  }

  // 读 body 也可能失败（连接被重置等），和 fetch 本身一样归到「发不出去」这一类。
  let text = '';
  try {
    text = await response.text();
  } catch {
    throw new ApiError(0, '读取响应失败，请重试');
  }

  const body = parseJson(text);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      readErrorMessage(body) ?? `请求失败（HTTP ${response.status}）`,
    );
  }
  if (body === undefined) {
    // 200 却不是 JSON，通常意味着请求被别的东西接管了（例如代理没配好返回了首页 HTML）。
    throw new ApiError(response.status, '后端返回的不是 JSON');
  }
  return body as T;
}

/** 解析失败一律当作「没有 body」，让上层用状态码给出兜底文案，而不是抛 JSON 语法错误。 */
function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 只认契约里的 `{ error: string }`；其它形状交给调用方用兜底文案。 */
function readErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as { error?: unknown };
  return typeof error === 'string' && error !== '' ? error : undefined;
}

/** 读某一层看板。parentId 为 null 时读根看板。 */
export function fetchBoard(parentId: string | null): Promise<Board> {
  const path = parentId === null ? '/api/board' : `/api/board/${encodeURIComponent(parentId)}`;
  return request<Board>(path);
}

/**
 * 「显示已归档」开关。后端认 `1` 和 `true`（见 docs/spec.md），这里统一发 `1`。
 * 开关状态只存在前端（D24），所以每次都要显式传，不能靠后端记住。
 */
function archivedQuery(includeArchived: boolean): string {
  return includeArchived ? '?includeArchived=1' : '';
}

/** 读完整任务树，用来建左侧文件树。默认不含归档节点。 */
export function fetchTree(includeArchived: boolean): Promise<TreeTask[]> {
  return request<{ tasks: TreeTask[] }>(`/api/tree${archivedQuery(includeArchived)}`).then(
    (body) => body.tasks,
  );
}

/** 读某个任务的面包屑（从根看板到该任务，含两端）。 */
export function fetchBreadcrumb(taskId: string): Promise<BreadcrumbItem[]> {
  return request<{ items: BreadcrumbItem[] }>(
    `/api/breadcrumb/${encodeURIComponent(taskId)}`,
  ).then((body) => body.items);
}
