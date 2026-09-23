import type { Board, BreadcrumbItem, SearchResponse, TaskRecord, TreeTask } from './types';

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

/** 写请求的附加参数。只有需要写库时才传 method 与 body。 */
interface WriteInit {
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/** 开发时走 Vite 的代理，生产同源部署，所以路径里不写主机与端口。 */
async function request<T>(path: string, init?: WriteInit): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // 带 body 的写请求必须声明 JSON：后端对不带 application/json 的 POST/PATCH 直接回 400（见 D15）。
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
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

/**
 * 「显示已归档」开关。后端认 `1` 和 `true`（见 docs/spec.md），这里统一发 `1`。
 * 开关状态只存在前端（D24），所以每次都要显式传，不能靠后端记住。
 * 看板、文件树、搜索以及文件树的重新取数都走这一个函数，避免几处各写一遍。
 */
function withArchived(url: string, includeArchived: boolean): string {
  if (!includeArchived) return url;
  return url.includes('?') ? `${url}&includeArchived=1` : `${url}?includeArchived=1`;
}

/** 读某一层看板。parentId 为 null 时读根看板。开关打开时列里也带归档卡片。 */
export function fetchBoard(parentId: string | null, includeArchived: boolean): Promise<Board> {
  const path = parentId === null ? '/api/board' : `/api/board/${encodeURIComponent(parentId)}`;
  return request<Board>(withArchived(path, includeArchived));
}

/** 读完整任务树，用来建左侧文件树。默认不含归档节点。 */
export function fetchTree(includeArchived: boolean): Promise<TreeTask[]> {
  return request<{ tasks: TreeTask[] }>(withArchived('/api/tree', includeArchived)).then(
    (body) => body.tasks,
  );
}

/** 读某个任务的面包屑（从根看板到该任务，含两端）。 */
export function fetchBreadcrumb(taskId: string): Promise<BreadcrumbItem[]> {
  return request<{ items: BreadcrumbItem[] }>(
    `/api/breadcrumb/${encodeURIComponent(taskId)}`,
  ).then((body) => body.items);
}

/**
 * 全库搜索。关键词两端空白在这里去掉，与后端 trim 的口径一致；
 * 空白关键词不该走到这里（调用方据此不发请求），所以不做特判，让后端回 400 暴露调用方的问题。
 * `includeArchived` 与其它读接口同一个开关：打开后归档任务也参与匹配。
 */
export function fetchSearch(keyword: string, includeArchived: boolean): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: keyword.trim() });
  return request<SearchResponse>(withArchived(`/api/search?${params.toString()}`, includeArchived));
}

/** 新建任务的入参。工期与描述不在这里给：建完在面板里改（见 docs/decisions.md D33）。 */
export interface CreateTaskInput {
  parentId: string | null;
  columnId: string;
  title: string;
}

/**
 * 新建任务，追加到目标列末尾。
 * 响应是新建出来的任务记录本身（不含子任务计数）——新任务还没有子任务，计数一定是 0/0。
 */
export function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  return request<TaskRecord>('/api/tasks', { method: 'POST', body: input });
}

/** 改基础字段。省略的字段不动，`durationMinutes: null` 表示改回未估工期。 */
export interface TaskFieldsPatch {
  title?: string;
  description?: string;
  durationMinutes?: number | null;
}

/**
 * PATCH 系写接口（改字段、归档）的响应是 `{ task, columnTasks }`。这里只取 `task`：
 * 前端在写成功后统一静默重取看板、文件树与面包屑，不用响应里的 `columnTasks` 做整列替换
 * （理由见 docs/decisions.md D35）。接口契约不变，多余的那一半只是不消费。
 * `POST /api/tasks` 返回的是裸任务记录，不走这个函数（见 createTask）。
 */
function readWrittenTask(body: { task: TaskRecord }): TaskRecord {
  return body.task;
}

/** 改标题 / 描述 / 工期。 */
export function updateTaskFields(id: string, patch: TaskFieldsPatch): Promise<TaskRecord> {
  return request<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  }).then(readWrittenTask);
}

/** 归档或取消归档整棵子树。归档是唯一接受已归档任务的写接口，所以这里没有额外判断。 */
export function setTaskArchived(id: string, archived: boolean): Promise<TaskRecord> {
  return request<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(id)}/archive`, {
    method: 'PATCH',
    body: { archived },
  }).then(readWrittenTask);
}

/**
 * 移动任务：目标列 + 目标列里的 0 基插入下标。
 * `position` 的口径是「先把任务移出、再插入」，取值域由 `domain/board.ts` 的
 * `positionForDrop` 负责换算（列里可能混着不参与重排的归档卡片）。
 */
export function moveTask(
  id: string,
  input: { columnId: string; position: number },
): Promise<TaskRecord> {
  return request<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  }).then(readWrittenTask);
}

/** 文件树拖动改父级：任务挂到新父级下，并追加到目标列末尾（见 docs/spec.md 的 API 契约）。 */
export function changeTaskParent(
  id: string,
  input: { parentId: string | null; columnId: string },
): Promise<TaskRecord> {
  return request<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(id)}/parent`, {
    method: 'PATCH',
    body: input,
  }).then(readWrittenTask);
}

/** 删除任务及其整棵子树。响应只有删除后那一列的任务列表，这里不需要，删掉的id由调用方知道。 */
export function deleteTask(id: string): Promise<void> {
  return request<unknown>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(
    () => undefined,
  );
}
