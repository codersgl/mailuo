import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  REQUEST_TIMEOUT_MS,
  changeTaskParent,
  createTask,
  deleteTask,
  fetchBoard,
  fetchLayerSchedule,
  fetchSearch,
  moveTask,
  setTaskArchived,
  setTaskDeps,
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

/** PATCH 系写接口的响应形状是 `{ task, columnTasks }`，这里只关心 task。 */
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

  it('搜索把关键词编码进 q，开关打开时追加 includeArchived=1（已有的 ? 后面用 & 接）', async () => {
    const calls = stubFetch(() => jsonResponse(200, { columns: [], results: [], truncated: false }));

    await fetchSearch('重构 登录', false);
    await fetchSearch('a/b', true);

    expect(calls.map((call) => call.url)).toEqual([
      '/api/search?q=%E9%87%8D%E6%9E%84+%E7%99%BB%E5%BD%95',
      '/api/search?q=a%2Fb&includeArchived=1',
    ]);
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
 * 超时（审计报告 C1）。
 *
 * 这里不真的等 10 秒：真正要钉住的是「fetch 拿到超时信号」与「超时被翻译成哪句文案」。
 * 三条分别覆盖请求阶段超时、读 body 阶段超时，以及「非超时的失败仍是原来那句文案」。
 */
describe('请求超时', () => {
  it('每次请求都带上一个超时信号，超时值是 10 秒', async () => {
    const calls = stubFetch(() => jsonResponse(200, { parentId: null, columns: [] }));

    await fetchBoard(null, false);

    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect((calls[0]?.init?.signal as AbortSignal).aborted).toBe(false);
  });

  it('请求阶段超时给出可重试的文案，而不是「连不上后端」', async () => {
    stubFetch(() => {
      throw new DOMException('signal timed out', 'TimeoutError');
    });

    const failure = await fetchBoard(null, false).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(0);
    expect((failure as ApiError).message).toBe('后端响应超时，请重试');
  });

  it('只给 AbortError 的实现按超时处理（同一件事的两种抛法）', async () => {
    stubFetch(() => {
      throw new DOMException('aborted', 'AbortError');
    });

    const failure = await fetchBoard(null, false).catch((cause: unknown) => cause);

    expect((failure as ApiError).message).toBe('后端响应超时，请重试');
  });

  it('读 body 时超时同样给超时文案', async () => {
    stubFetch(
      () =>
        ({
          ok: true,
          status: 200,
          text: () => Promise.reject(new DOMException('signal timed out', 'TimeoutError')),
        }) as unknown as Response,
    );

    const failure = await fetchBoard(null, false).catch((cause: unknown) => cause);

    expect((failure as ApiError).message).toBe('后端响应超时，请重试');
  });

  it('不是超时的失败仍是原来那句「连不上后端」', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    const failure = await fetchBoard(null, false).catch((cause: unknown) => cause);

    expect((failure as ApiError).message).toContain('连不上后端');
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

  it('moveTask 用 PATCH 提交 { columnId, position }', async () => {
    const calls = stubFetch(() =>
      jsonResponse(200, { task: taskRecord({ columnId: 'doing' }), columnTasks: [] }),
    );

    const task = await moveTask('t1', { columnId: 'doing', position: 2 });

    expect(calls[0]?.url).toBe('/api/tasks/t1');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ columnId: 'doing', position: 2 }));
    expect(task.columnId).toBe('doing');
  });

  it('changeTaskParent 用 PATCH 打 parent 子路径，parentId 可以是 null', async () => {
    const calls = stubFetch(() =>
      jsonResponse(200, { task: taskRecord({ parentId: null }), columnTasks: [] }),
    );

    await changeTaskParent('t1', { parentId: null, columnId: 'todo' });

    expect(calls[0]?.url).toBe('/api/tasks/t1/parent');
    expect(calls[0]?.init?.method).toBe('PATCH');
    // parentId: null 表示挂到根看板，不能因为「假值」被丢掉。
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ parentId: null, columnId: 'todo' }));
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

describe('fetchLayerSchedule', () => {
  it('根看板走 /api/board/cpm，子层把 id 拼进路径', async () => {
    const calls = stubFetch(() =>
      jsonResponse(200, { parentId: null, projectDuration: 0, nodes: [], edges: [] }),
    );

    await fetchLayerSchedule(null, false);
    await fetchLayerSchedule('a b', false);

    expect(calls.map((call) => call.url)).toEqual(['/api/board/cpm', '/api/board/a%20b/cpm']);
  });

  it('开关打开时追加 includeArchived=1', async () => {
    const calls = stubFetch(() =>
      jsonResponse(200, { parentId: null, projectDuration: 0, nodes: [], edges: [] }),
    );

    await fetchLayerSchedule('t1', true);

    expect(calls.map((call) => call.url)).toEqual(['/api/board/t1/cpm?includeArchived=1']);
  });

  it('把响应的四个字段原样带出来', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        parentId: 't1',
        projectDuration: 210,
        nodes: [{ id: 'a', title: '甲', durationMinutes: null }],
        edges: [{ predecessorId: 'a', successorId: 'b', critical: false }],
      }),
    );

    const schedule = await fetchLayerSchedule('t1', false);

    expect(schedule.projectDuration).toBe(210);
    expect(schedule.nodes[0]?.durationMinutes).toBeNull();
    expect(schedule.edges[0]?.successorId).toBe('b');
  });
});

describe('setTaskDeps', () => {
  it('用 PUT 整体替换前置依赖，声明 JSON 并只带 predecessorIds', async () => {
    const calls = stubFetch(() => jsonResponse(200, { task: taskRecord(), predecessorIds: ['a'] }));

    const task = await setTaskDeps('t1', ['a']);

    expect(calls[0]?.url).toBe('/api/tasks/t1/deps');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect((calls[0]?.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ predecessorIds: ['a'] }));
    // 响应里的 task 就是改过依赖的那条记录，调用方据此更新本地快照。
    expect(task.id).toBe('t1');
  });

  it('空数组表示清空，照原样发出去', async () => {
    const calls = stubFetch(() => jsonResponse(200, { task: taskRecord(), predecessorIds: [] }));

    await setTaskDeps('t1', []);

    expect(calls[0]?.init?.body).toBe(JSON.stringify({ predecessorIds: [] }));
  });

  it('环与跨层这类拒绝把后端文案带出来（409 / 400）', async () => {
    // 文案照真后端（apps/api/src/routes/tasks.ts 回 409 `依赖形成环: <id>`）。
    stubFetch(() => jsonResponse(409, { error: '依赖形成环: b' }));

    const failure = await setTaskDeps('t1', ['b']).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).message).toBe('依赖形成环: b');
  });
});
