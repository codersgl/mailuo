import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import {
  createTestDb,
  insertTask,
  readJson,
  type BoardBody,
  type TaskMutationBody,
  type TreeBody,
} from './helpers.js';

type App = ReturnType<typeof createApp>;

function patchJson(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function archive(app: App, id: string, archived: boolean) {
  return patchJson(app, `/api/tasks/${id}/archive`, { archived });
}

/** 直接读库断言归档字段：接口只返回单个任务的 archivedAt，子树得看库。 */
function archivedAt(db: Db, id: string): string | null {
  const row = db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as
    | { archived_at: string | null }
    | undefined;
  if (!row) throw new Error(`任务不存在: ${id}`);
  return row.archived_at;
}

function updatedAt(db: Db, id: string): string {
  const row = db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(id) as { updated_at: string };
  return row.updated_at;
}

async function columnTitles(app: App, parentId: string | null, columnId: string): Promise<string[]> {
  const path = parentId === null ? '/api/board' : `/api/board/${parentId}`;
  const board = await readJson<BoardBody>(await app.request(path));
  const column = board.columns.find((item: { id: string }) => item.id === columnId)!;
  return column.tasks.map((task: { title: string }) => task.title);
}

async function treeIds(app: App, includeArchived = false): Promise<string[]> {
  const path = includeArchived ? '/api/tree?includeArchived=1' : '/api/tree';
  const body = await readJson<TreeBody>(await app.request(path));
  return body.tasks.map((task: { id: string }) => task.id);
}

describe('PATCH /api/tasks/:id/archive', () => {
  it('归档整棵子树，并从默认的看板与任务树里消失', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    // C 停在待办而不是进行中：它若在进行中，整条祖先链（B、A）会被状态推导成进行中，
    // 而这两个用例守的是归档/取消归档的列与位置，不是推导（推导见 derive.test.ts 与 api 用例）。
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 1000, parentId: bId });
    const dId = insertTask(db, { title: 'D', columnId: 'todo', orders: 2000 });
    const api = createApp(db);

    const response = await archive(api, aId, true);

    expect(response.status).toBe(200);
    const { task, columnTasks } = await readJson<TaskMutationBody>(response);
    expect(task.archivedAt).not.toBeNull();
    // 归档后任务不在任何列里，所以返回的整列里没有它，同列的 D 还在原位。
    expect(columnTasks.map((item: { title: string }) => item.title)).toEqual(['D']);

    expect(archivedAt(db, aId)).not.toBeNull();
    expect(archivedAt(db, bId)).not.toBeNull();
    expect(archivedAt(db, cId)).not.toBeNull();
    expect(archivedAt(db, dId)).toBeNull();

    expect(await columnTitles(api, null, 'todo')).toEqual(['D']);
    expect(await treeIds(api)).toEqual([dId]);
  });

  it('includeArchived=1 时看板与任务树带上归档任务', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    const api = createApp(db);

    await archive(api, aId, true);

    const board = await readJson<BoardBody>(await api.request('/api/board?includeArchived=1'));
    expect(board.columns[0]!.tasks.map((t: { title: string }) => t.title)).toEqual(['A']);
    expect(await treeIds(api, true)).toEqual([aId, bId]);
  });

  it('子看板 /api/board/:parentId 也认 includeArchived，且 true 与 1 等价', async () => {
    const db = createTestDb();
    const pId = insertTask(db, { title: 'P', columnId: 'todo', orders: 1000 });
    const xId = insertTask(db, {
      title: 'X',
      columnId: 'todo',
      orders: 1000,
      parentId: pId,
      archived: true,
    });
    const yId = insertTask(db, { title: 'Y', columnId: 'todo', orders: 2000, parentId: pId });
    const api = createApp(db);

    const visible = await readJson<BoardBody>(await api.request(`/api/board/${pId}`));
    expect(visible.columns[0]!.tasks.map((t: { id: string }) => t.id)).toEqual([yId]);

    for (const value of ['1', 'true']) {
      const full = await readJson<BoardBody>(await api.request(`/api/board/${pId}?includeArchived=${value}`));
      expect(full.columns[0]!.tasks.map((t: { id: string }) => t.id)).toEqual([xId, yId]);
    }

    const tree = await readJson<TreeBody>(await api.request('/api/tree?includeArchived=true'));
    expect(tree.tasks.map((t: { id: string }) => t.id).sort()).toEqual([pId, xId, yId].sort());
  });

  it('写接口沿用 includeArchived：显示归档时整列替换不会丢归档卡片', async () => {
    const db = createTestDb();
    const pId = insertTask(db, { title: 'P', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: 'X', columnId: 'todo', orders: 1000, parentId: pId, archived: true });
    const yId = insertTask(db, { title: 'Y', columnId: 'todo', orders: 2000, parentId: pId });
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${yId}?includeArchived=1`, { title: 'Y2' });

    expect(response.status).toBe(200);
    const { columnTasks } = await readJson<TaskMutationBody>(response);
    expect(columnTasks.map((item: { title: string }) => item.title)).toEqual(['X', 'Y2']);

    // 不带参数时保持原样：写响应的整列只含可见任务。
    const plain = await patchJson(api, `/api/tasks/${yId}`, { title: 'Y3' });
    expect((await readJson<TaskMutationBody>(plain)).columnTasks.map((item: { title: string }) => item.title)).toEqual([
      'Y3',
    ]);
  });

  it('显示已归档的看板不改变进度计数口径：归档子任务仍不入分母', async () => {
    const db = createTestDb();
    const pId = insertTask(db, { title: 'P', columnId: 'todo', orders: 1000 });
    const doneChild = insertTask(db, { title: 'done', columnId: 'done', orders: 1000, parentId: pId });
    insertTask(db, { title: 'todo', columnId: 'todo', orders: 1000, parentId: pId });
    const api = createApp(db);

    const before = await readJson<BoardBody>(await api.request('/api/board'));
    expect(before.columns[0]!.tasks[0]).toMatchObject({ childTotal: 2, childDone: 1 });

    await archive(api, doneChild, true);

    const after = await readJson<BoardBody>(await api.request('/api/board'));
    expect(after.columns[0]!.tasks[0]).toMatchObject({ childTotal: 1, childDone: 0 });
    const withArchived = await readJson<BoardBody>(await api.request('/api/board?includeArchived=1'));
    expect(withArchived.columns[0]!.tasks[0]).toMatchObject({ childTotal: 1, childDone: 0 });
  });

  it('取消归档恢复整棵子树，任务回到原列原位置', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    // C 停在待办而不是进行中：它若在进行中，整条祖先链（B、A）会被状态推导成进行中，
    // 而这两个用例守的是归档/取消归档的列与位置，不是推导（推导见 derive.test.ts 与 api 用例）。
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 1000, parentId: bId });
    insertTask(db, { title: 'D', columnId: 'todo', orders: 2000 });
    const api = createApp(db);

    await archive(api, aId, true);
    const response = await archive(api, aId, false);

    expect(response.status).toBe(200);
    const { task, columnTasks } = await readJson<TaskMutationBody>(response);
    expect(task.archivedAt).toBeNull();
    // orders 不因归档而变化，所以回到原位而不是列末。
    expect(task.orders).toBe(1000);
    expect(columnTasks.map((item: { title: string }) => item.title)).toEqual(['A', 'D']);
    expect(archivedAt(db, aId)).toBeNull();
    expect(archivedAt(db, bId)).toBeNull();
    expect(archivedAt(db, cId)).toBeNull();
  });

  it('取消归档一个子任务时把仍处于归档的祖先一并恢复', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    // C 停在待办而不是进行中：它若在进行中，整条祖先链（B、A）会被状态推导成进行中，
    // 而这两个用例守的是归档/取消归档的列与位置，不是推导（推导见 derive.test.ts 与 api 用例）。
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 1000, parentId: bId });
    // 另一棵独立子树，用来验证父链恢复不会波及无关分支。
    const eId = insertTask(db, { title: 'E', columnId: 'todo', orders: 2000 });
    const fId = insertTask(db, { title: 'F', columnId: 'todo', orders: 1000, parentId: eId });
    const api = createApp(db);

    await archive(api, aId, true);
    await archive(api, eId, true);

    await archive(api, cId, false);

    expect(archivedAt(db, cId)).toBeNull();
    expect(archivedAt(db, bId)).toBeNull();
    expect(archivedAt(db, aId)).toBeNull();
    // 无关分支保持归档，A 的父链恢复不牵连它。
    expect(archivedAt(db, eId)).not.toBeNull();
    expect(archivedAt(db, fId)).not.toBeNull();
    expect(await columnTitles(api, null, 'todo')).toEqual(['A']);
  });

  it('取消归档已经恢复过的任务不刷新 updated_at（幂等空操作）', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    await archive(api, aId, true);
    await archive(api, aId, false);
    const restored = updatedAt(db, aId);

    const second = await archive(api, aId, false);

    expect(second.status).toBe(200);
    expect(updatedAt(db, aId)).toBe(restored);
    expect(archivedAt(db, aId)).toBeNull();
  });

  it('重复归档保留首次归档时间，不刷新 updated_at', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    await archive(api, aId, true);
    const firstArchivedAt = archivedAt(db, aId);
    const firstUpdatedAt = updatedAt(db, aId);

    const second = await archive(api, aId, true);

    expect(second.status).toBe(200);
    expect(archivedAt(db, aId)).toBe(firstArchivedAt);
    expect(updatedAt(db, aId)).toBe(firstUpdatedAt);
  });

  it('归档后普通 PATCH 仍被拒，取消归档后可再改', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    await archive(api, aId, true);
    const rejected = await patchJson(api, `/api/tasks/${aId}`, { title: '新标题' });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: '任务已归档' });

    await archive(api, aId, false);
    const accepted = await patchJson(api, `/api/tasks/${aId}`, { title: '新标题' });
    expect(accepted.status).toBe(200);
    expect((await readJson<TaskMutationBody>(accepted)).task.title).toBe('新标题');
  });

  it('任务不存在返回 404', async () => {
    const db = createTestDb();
    const api = createApp(db);

    expect((await archive(api, 'missing', true)).status).toBe(404);
    expect((await archive(api, 'missing', false)).status).toBe(404);
    expect(await (await archive(api, 'missing', true)).json()).toEqual({ error: '任务不存在' });
  });

  it('archived 缺失、类型不对或带未知字段都返回 400', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const missing = await patchJson(api, `/api/tasks/${aId}/archive`, {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'archived: 不能为空' });

    const wrongType = await patchJson(api, `/api/tasks/${aId}/archive`, { archived: 'yes' });
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toEqual({ error: 'archived: 必须是布尔值' });

    const unknown = await patchJson(api, `/api/tasks/${aId}/archive`, { archived: true, extra: 1 });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: '存在未定义的字段' });
  });

  it('Content-Type 不是 JSON 时返回 400', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const response = await api.request(`/api/tasks/${aId}/archive`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'archived=true',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Content-Type 必须是 application/json' });
  });

  it('父子成环的脏数据下子树与父链递归都能终止', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    // 外键只要求父行存在，手工改库就能造出 A→B→A 的环。接口不可能造出来（D17）。
    db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(bId, aId);
    const api = createApp(db);

    expect((await archive(api, aId, true)).status).toBe(200);
    expect(archivedAt(db, aId)).not.toBeNull();
    expect(archivedAt(db, bId)).not.toBeNull();

    // 取消归档走的是另一条递归（向上找祖先），同样要能停下来。
    expect((await archive(api, bId, false)).status).toBe(200);
    expect(archivedAt(db, aId)).toBeNull();
    expect(archivedAt(db, bId)).toBeNull();
  });
});

describe('includeArchived 的取值口径', () => {
  it('只有 1 与 true 算打开，0 / false / yes / TRUE / 空 / 缺省都算关闭', async () => {
    // 审计的变异检验实测：把 query.ts 的判定改成「带参数就算开」，66 条相关用例全绿
    // （见审计报告 E1）。表现是用户关掉「显示已归档」后归档卡片却还在，所以取值表要全。
    const db = createTestDb();
    const visibleId = insertTask(db, { title: '正常任务', columnId: 'todo', orders: 1000 });
    const archivedId = insertTask(db, {
      title: '归档任务',
      columnId: 'todo',
      orders: 2000,
      archived: true,
    });
    const api = createApp(db);

    const visibleIds = async (query: string) => {
      const board = await readJson<BoardBody>(await api.request(`/api/board${query}`));
      return board.columns[0]!.tasks.map((task: { id: string }) => task.id);
    };

    for (const value of ['1', 'true']) {
      expect(await visibleIds(`?includeArchived=${value}`)).toEqual([visibleId, archivedId]);
    }
    for (const value of ['0', 'false', 'yes', 'TRUE', '']) {
      expect(await visibleIds(`?includeArchived=${value}`)).toEqual([visibleId]);
    }
    // 不带参数：缺省关闭。
    expect(await visibleIds('')).toEqual([visibleId]);
  });
});
