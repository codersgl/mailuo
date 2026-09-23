import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { createTestDb, insertTask } from './helpers.js';

type App = ReturnType<typeof createApp>;

function putJson(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setDeps(app: App, id: string, predecessorIds: string[]) {
  return putJson(app, `/api/tasks/${id}/deps`, { predecessorIds });
}

/** 库里的依赖边，格式 `前置->后继`，排序后方便整份对比。 */
function depRows(db: Db): string[] {
  const rows = db
    .prepare('SELECT predecessor_id, successor_id FROM task_deps')
    .all() as Array<{ predecessor_id: string; successor_id: string }>;
  return rows.map((row) => `${row.predecessor_id}->${row.successor_id}`).sort();
}

function updatedAt(db: Db, id: string): string {
  const row = db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(id) as { updated_at: string };
  return row.updated_at;
}

/**
 * 断言「没刷新」用的哨兵时间戳：先写死这个值，再发请求。
 * 直接比较前后两次 `new Date()` 会依赖两次调用跨毫秒，同一毫秒内静默通过。
 */
const SENTINEL_UPDATED_AT = '2000-01-01T00:00:00.000Z';

function setUpdatedAt(db: Db, id: string): void {
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(SENTINEL_UPDATED_AT, id);
}

describe('PUT /api/tasks/:id/deps', () => {
  it('设置前置依赖：写入库并返回改动后的任务与升序 id 列表', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const cId = insertTask(db, { title: 'C', columnId: 'doing', orders: 1000 });
    const api = createApp(db);

    const response = await setDeps(api, cId, [bId, aId]);

    expect(response.status).toBe(200);
    const { task, predecessorIds } = await response.json();
    expect(task.id).toBe(cId);
    expect(predecessorIds).toEqual([aId, bId].sort());
    expect(depRows(db)).toEqual([`${aId}->${cId}`, `${bId}->${cId}`].sort());
  });

  it('同层不同列允许：依赖只看 parentId，不看 columnId', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'todo', orders: 1000 });
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000, parentId });
    const bId = insertTask(db, { title: 'B', columnId: 'done', orders: 1000, parentId });
    const api = createApp(db);

    const response = await setDeps(api, bId, [aId]);

    expect(response.status).toBe(200);
    expect(depRows(db)).toEqual([`${aId}->${bId}`]);
  });

  it('整体替换：不在新列表里的旧依赖被删掉，空数组清空', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 3000 });
    const api = createApp(db);

    await setDeps(api, cId, [aId, bId]);
    const replaced = await setDeps(api, cId, [bId]);
    expect((await replaced.json()).predecessorIds).toEqual([bId]);
    expect(depRows(db)).toEqual([`${bId}->${cId}`]);

    const cleared = await setDeps(api, cId, []);
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).predecessorIds).toEqual([]);
    expect(depRows(db)).toEqual([]);
  });

  it('重复依赖集合是幂等空操作，不刷新 updated_at', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const taskId = insertTask(db, { title: 'T', columnId: 'todo', orders: 3000 });
    const api = createApp(db);

    await setDeps(api, taskId, [aId, bId]);
    // 写入哨兵时间戳再发第二次请求：「有没有被刷新」于是不依赖两次 new Date() 是否跨毫秒。
    // 依赖真实时钟的话，同一毫秒内的重复写入会让这条守卫静默通过（见审阅补记）。
    setUpdatedAt(db, taskId);

    // 两个前置任务反序提交：集合相同、顺序不同，同样算没变。
    // 这条同时盯着 setTaskDeps 的「去重 + 排序」——少了它，反序提交会被当成一次真改动。
    const again = await setDeps(api, taskId, [bId, aId]);

    expect(again.status).toBe(200);
    expect(updatedAt(db, taskId)).toBe(SENTINEL_UPDATED_AT);
    expect(depRows(db)).toEqual([`${aId}->${taskId}`, `${bId}->${taskId}`].sort());
  });

  it('依赖真的变了才刷新 updated_at', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const api = createApp(db);
    setUpdatedAt(db, bId);

    await setDeps(api, bId, [aId]);

    expect(updatedAt(db, bId)).not.toBe(SENTINEL_UPDATED_AT);
  });

  it('任务不存在返回 404', async () => {
    const api = createApp(createTestDb());

    const response = await setDeps(api, '不存在的任务', []);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });

  it('任务已归档返回 400', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const archivedId = insertTask(db, {
      title: '归档任务',
      columnId: 'todo',
      orders: 2000,
      archived: true,
    });
    const api = createApp(db);

    const response = await setDeps(api, archivedId, [aId]);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '任务已归档' });
  });

  it('前置任务不存在返回 404，并指出是哪一个', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const response = await setDeps(api, aId, ['不存在的任务']);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '前置任务不存在: 不存在的任务' });
  });

  it('跨层依赖返回 400，并指出是哪一个', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'todo', orders: 1000 });
    const childId = insertTask(db, { title: '子任务', columnId: 'todo', orders: 1000, parentId });
    const otherId = insertTask(db, { title: '别的根任务', columnId: 'todo', orders: 2000 });
    const api = createApp(db);

    // 根任务依赖子层任务、子层任务依赖根任务，两个方向都不允许。
    const up = await setDeps(api, parentId, [childId]);
    expect(up.status).toBe(400);
    expect(await up.json()).toEqual({ error: `跨层依赖不允许: ${childId}` });

    const down = await setDeps(api, childId, [otherId]);
    expect(down.status).toBe(400);
    expect(await down.json()).toEqual({ error: `跨层依赖不允许: ${otherId}` });
  });

  it('前置任务已归档返回 400', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const archivedId = insertTask(db, {
      title: '归档任务',
      columnId: 'todo',
      orders: 2000,
      archived: true,
    });
    const api = createApp(db);

    const response = await setDeps(api, aId, [archivedId]);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `前置任务已归档: ${archivedId}` });
  });

  it('任务不能依赖自己（409）', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const response = await setDeps(api, aId, [aId]);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: '任务不能依赖自己' });
    expect(depRows(db)).toEqual([]);
  });

  it('直接成环返回 409，库保持原样', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const api = createApp(db);

    await setDeps(api, bId, [aId]);
    const response = await setDeps(api, aId, [bId]);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: `依赖形成环: ${bId}` });
    expect(depRows(db)).toEqual([`${aId}->${bId}`]);
  });

  it('间接成环（三层）返回 409', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 3000 });
    const api = createApp(db);

    await setDeps(api, bId, [aId]);
    await setDeps(api, cId, [bId]);
    const response = await setDeps(api, aId, [cId]);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: `依赖形成环: ${cId}` });
    expect(depRows(db)).toEqual([`${aId}->${bId}`, `${bId}->${cId}`].sort());
  });

  it('成环检查只看这一条链，无关的依赖不受影响', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 3000 });
    const dId = insertTask(db, { title: 'D', columnId: 'todo', orders: 4000 });
    const api = createApp(db);

    // A 依赖 B，C 依赖 D；把 D 设成 A 的前置不成环。
    await setDeps(api, aId, [bId]);
    await setDeps(api, cId, [dId]);
    const response = await setDeps(api, aId, [bId, dId]);

    expect(response.status).toBe(200);
    expect(depRows(db)).toEqual([`${bId}->${aId}`, `${dId}->${aId}`, `${dId}->${cId}`].sort());
  });

  it('入参形状：缺字段、类型不对、含空串、重复项、未知字段都返回 400', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const missing = await putJson(api, `/api/tasks/${aId}/deps`, {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'predecessorIds: 不能为空' });

    const wrongType = await putJson(api, `/api/tasks/${aId}/deps`, { predecessorIds: 'x' });
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toEqual({ error: 'predecessorIds: 前置依赖必须是数组' });

    const emptyId = await putJson(api, `/api/tasks/${aId}/deps`, { predecessorIds: [''] });
    expect(emptyId.status).toBe(400);
    expect(await emptyId.json()).toEqual({ error: 'predecessorIds.0: 前置任务 id 不能为空' });

    const duplicated = await putJson(api, `/api/tasks/${aId}/deps`, {
      predecessorIds: [aId, aId],
    });
    expect(duplicated.status).toBe(400);
    expect(await duplicated.json()).toEqual({ error: 'predecessorIds: 前置依赖不能重复' });

    const unknown = await putJson(api, `/api/tasks/${aId}/deps`, {
      predecessorIds: [],
      successorIds: [],
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: '存在未定义的字段' });
  });

  it('入参形状先于任务存在性：任务不存在但依赖重复时报 400', async () => {
    const api = createApp(createTestDb());

    const response = await putJson(api, '/api/tasks/不存在的任务/deps', {
      predecessorIds: ['a', 'a'],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'predecessorIds: 前置依赖不能重复' });
  });

  it('Content-Type 不是 JSON 时返回 400（PUT 也要拦）', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const response = await api.request(`/api/tasks/${aId}/deps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'predecessorIds=',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Content-Type 必须是 application/json' });
  });

  it('Content-Type 中间件只认 /api/tasks 与 /api/tasks/ 两个前缀', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    // 形近前缀不是任务接口：不该被这条中间件拦成 400。
    const similar = await api.request('/api/tasks-nope/x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    });
    expect(similar.status).toBe(404);
    expect(await similar.json()).toEqual({ error: 'not found' });

    // 真正在任务接口下、但方法不对的写请求仍会被拦（宁可多拦，见 routes/tasks.ts 的注释）。
    const wrongMethod = await api.request(`/api/tasks/${aId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    });
    expect(wrongMethod.status).toBe(400);
    expect(await wrongMethod.json()).toEqual({ error: 'Content-Type 必须是 application/json' });
  });
});
