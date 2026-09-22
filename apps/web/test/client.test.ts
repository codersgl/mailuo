import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createTask,
  deleteTask,
  fetchBoard,
  setTaskArchived,
  updateTaskFields,
} from '../src/api/client';

/** 一次请求的记录：路径与 init 都要看，写接口的方法、请求头、请求体都在 init 里。 */
interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/** 用假 fetch 覆盖全局，断言请求路径与各类失败路径的文案。 */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  });
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 写接口的响应形状是 `{ task, columnTasks }`，这里只关心 task。 */
function taskRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    parentId: null,
    columnId: 'todo',
    title: '写接口文档',
    description: '',
    durationMinutes: null,
    orders: 1000,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBoard', () => {
  it('parentId 为 null 时请求根看板，否则把 id 拼进路径并转义', async () => {
    const calls = stubFetch(() => jsonResponse(200, { parentId: null, columns: [] }));

    await fetchBoard(null, false);
    await fetchBoard('a b/c', false);

    expect(calls.map((call) => call.url)).toEqual(['/api/board', '/api/board/a%20b%2Fc']);
  });

  it('「显示已归档」打开时带上 includeArchived=1', async () => {
    const calls = stubFetch(() => jsonResponse(200, { parentId: null, columns: [] }));

    await fetchBoard('t1', true);

    expect(calls.map((call) => call.url)).toEqual(['/api/board/t1?includeArchived=1']);
  });

  it('成功时返回解析后的看板', async () => {
    stubFetch(() => jsonResponse(200, { parentId: null, columns: [{ id: 'todo' }] }));

    const board = await fetchBoard(null, false);

    expect(board.columns).toHaveLength(1);
  });

  it('把契约里的 { error } 变成 ApiError，保留状态码与中文文案', async () => {
    stubFetch(() => jsonResponse(404, { error: '任务不存在' }));

    const failure = await fetchBoard('missing', false).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(404);
    expect((failure as ApiError).message).toBe('任务不存在');
  });

  it('错误体不是契约形状时用状态码兜底，而不是抛 JSON 语法错误', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const failure = await fetchBoard(null, false).catch((cause: unknown) => cause);

    expect((failure as ApiError).message).toBe('请求失败（HTTP 502）');
  });

  it('请求发不出去时提示后端没启动', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    const failure = await fetchBoard(null, false).catch((cause: unknown) => cause);

    expect((failure as ApiError).status).toBe(0);
    expect((failure as ApiError).message).toContain('连不上后端');
  });

  it('200 但不是 JSON 时明确报错，避免上层拿到 undefined 崩在别处', async () => {
    stubFetch(() => new Response('<!doctype html>', { status: 200 }));

    const failure = await fetchBoard(null, false).catch((cause: unknown) => cause);

    expect((failure as ApiError).message).toBe('后端返回的不是 JSON');
  });
});

/**
 * 写接口的三条共性：方法、`Content-Type: application/json`（后端对不带的直接回 400，见 D15）、
 * 以及响应里 `{ task, columnTasks }` 只消费 task。
 */
describe('写接口', () => {
  it('createTask 用 POST 提交 JSON，返回新建出来的任务', async () => {
    const calls = stubFetch(() => jsonResponse(201, taskRecord({ id: 'new' })));

    const task = await createTask({ parentId: 'p1', columnId: 'todo', title: '新任务' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/tasks');
    expect(calls[0]?.init?.method).toBe('POST');
    expect((calls[0]?.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ parentId: 'p1', columnId: 'todo', title: '新任务' }),
    );
    expect(task.id).toBe('new');
  });

  it('updateTaskFields 用 PATCH，并只取响应里的 task', async () => {
    const calls = stubFetch(() =>
      jsonResponse(200, { task: taskRecord({ title: '改过的' }), columnTasks: [] }),
    );

    const task = await updateTaskFields('t 1', { title: '改过的', durationMinutes: null });

    expect(calls[0]?.url).toBe('/api/tasks/t%201');
    expect(calls[0]?.init?.method).toBe('PATCH');
    // durationMinutes 传 null 表示改回未估工期，序列化时不能被丢掉。
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ title: '改过的', durationMinutes: null }));
    expect(task.title).toBe('改过的');
  });

  it('setTaskArchived 用 PATCH 打 archive 子路径', async () => {
    const calls = stubFetch(() =>
      jsonResponse(200, {
        task: taskRecord({ archivedAt: '2026-09-22T01:00:00.000Z' }),
        columnTasks: [],
      }),
    );

    const task = await setTaskArchived('t1', true);

    expect(calls[0]?.url).toBe('/api/tasks/t1/archive');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ archived: true }));
    expect(task.archivedAt).not.toBeNull();
  });

  it('deleteTask 用 DELETE，且不带 Content-Type：它没有请求体', async () => {
    const calls = stubFetch(() => jsonResponse(200, { columnTasks: [] }));

    await deleteTask('t1');

    expect(calls[0]?.url).toBe('/api/tasks/t1');
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect((calls[0]?.init?.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('写失败时把后端文案包成 ApiError，与读接口一致', async () => {
    stubFetch(() => jsonResponse(400, { error: '标题不能为空' }));

    const failure = await createTask({ parentId: null, columnId: 'todo', title: '' }).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toBe('标题不能为空');
  });
});
