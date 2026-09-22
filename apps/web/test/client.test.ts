import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchBoard } from '../src/api/client';

/** 用假 fetch 覆盖全局，断言请求路径与各类失败路径的文案。 */
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    calls.push(String(input));
    return handler(String(input));
  });
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBoard', () => {
  it('parentId 为 null 时请求根看板，否则把 id 拼进路径并转义', async () => {
    const calls = stubFetch(() => jsonResponse(200, { parentId: null, columns: [] }));

    await fetchBoard(null);
    await fetchBoard('a b/c');

    expect(calls).toEqual(['/api/board', '/api/board/a%20b%2Fc']);
  });

  it('成功时返回解析后的看板', async () => {
    stubFetch(() => jsonResponse(200, { parentId: null, columns: [{ id: 'todo' }] }));

    const board = await fetchBoard(null);

    expect(board.columns).toHaveLength(1);
  });

  it('把契约里的 { error } 变成 ApiError，保留状态码与中文文案', async () => {
    stubFetch(() => jsonResponse(404, { error: '任务不存在' }));

    const failure = await fetchBoard('missing').catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(404);
    expect((failure as ApiError).message).toBe('任务不存在');
  });

  it('错误体不是契约形状时用状态码兜底，而不是抛 JSON 语法错误', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const failure = await fetchBoard(null).catch((cause: unknown) => cause);

    expect((failure as ApiError).message).toBe('请求失败（HTTP 502）');
  });

  it('请求发不出去时提示后端没启动', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    const failure = await fetchBoard(null).catch((cause: unknown) => cause);

    expect((failure as ApiError).status).toBe(0);
    expect((failure as ApiError).message).toContain('连不上后端');
  });

  it('200 但不是 JSON 时明确报错，避免上层拿到 undefined 崩在别处', async () => {
    stubFetch(() => new Response('<!doctype html>', { status: 200 }));

    const failure = await fetchBoard(null).catch((cause: unknown) => cause);

    expect((failure as ApiError).message).toBe('后端返回的不是 JSON');
  });
});
