import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { createTestDb, insertTask } from './helpers.js';

type App = ReturnType<typeof createApp>;

function archive(app: App, id: string, archived: boolean) {
  return app.request(`/api/tasks/${id}/archive`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
}

function remove(app: App, id: string) {
  return app.request(`/api/tasks/${id}`, { method: 'DELETE' });
}

function insertDep(db: Db, predecessorId: string, successorId: string): void {
  db.prepare('INSERT INTO task_deps (predecessor_id, successor_id) VALUES (?, ?)').run(
    predecessorId,
    successorId,
  );
}

/** 库里还剩哪些任务 id，用来断言级联删除真的删干净了。 */
function remainingIds(db: Db): string[] {
  const rows = db.prepare('SELECT id FROM tasks ORDER BY id').all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function remainingDeps(db: Db): string[] {
  const rows = db
    .prepare('SELECT predecessor_id, successor_id FROM task_deps ORDER BY predecessor_id, successor_id')
    .all() as Array<{ predecessor_id: string; successor_id: string }>;
  return rows.map((row) => `${row.predecessor_id}->${row.successor_id}`);
}

describe('DELETE /api/tasks/:id', () => {
  it('级联删除整棵子树，并返回它原来所在列的整列', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'doing', orders: 1000, parentId: aId });
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 1000, parentId: bId });
    const dId = insertTask(db, { title: 'D', columnId: 'todo', orders: 2000, parentId: cId });
    const keepId = insertTask(db, { title: 'E', columnId: 'todo', orders: 3000 });
    const api = createApp(db);

    // 先确认这棵树真的建起来了（5 个节点），否则「删完只剩 E」这条断言在空库上也成立。
    expect(remainingIds(db).sort()).toEqual([aId, bId, cId, dId, keepId].sort());

    const response = await remove(api, aId);

    expect(response.status).toBe(200);
    const { columnTasks } = await response.json();
    expect(columnTasks.map((item: { title: string }) => item.title)).toEqual(['E']);
    // 一条 DELETE 连父子一起删：外键检查在语句结束时做，不构成中间态。
    expect(remainingIds(db)).toEqual([keepId]);
  });

  it('删除时清掉这些任务作为任意一端的依赖记录，无关依赖不动', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    const xId = insertTask(db, { title: 'X', columnId: 'todo', orders: 2000 });
    const yId = insertTask(db, { title: 'Y', columnId: 'todo', orders: 3000 });
    insertDep(db, aId, bId); // 两端都在子树里
    insertDep(db, bId, xId); // 只有前置在子树里
    insertDep(db, xId, aId); // 只有后继在子树里
    insertDep(db, xId, yId); // 完全无关
    const api = createApp(db);

    const response = await remove(api, aId);

    expect(response.status).toBe(200);
    expect(remainingDeps(db)).toEqual([`${xId}->${yId}`]);
  });

  it('删除叶子任务不影响同列其他任务的 orders', async () => {
    const db = createTestDb();
    insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    insertTask(db, { title: 'C', columnId: 'todo', orders: 3000 });
    const api = createApp(db);

    await remove(api, bId);

    const board = await (await api.request('/api/board')).json();
    expect(
      board.columns[0].tasks.map((task: { title: string; orders: number }) => [task.title, task.orders]),
    ).toEqual([
      ['A', 1000],
      ['C', 3000],
    ]);
  });

  it('已归档任务也能删除', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    const api = createApp(db);

    await archive(api, aId, true);
    expect(remainingIds(db).sort()).toEqual([aId, bId].sort());

    const response = await remove(api, aId);

    expect(response.status).toBe(200);
    expect((await response.json()).columnTasks).toEqual([]);
    expect(remainingIds(db)).toEqual([]);
  });

  it('删除后看板、文件树与面包屑都查不到', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    const api = createApp(db);

    await remove(api, bId);

    const board = await (await api.request('/api/board')).json();
    expect(board.columns[0].tasks).toMatchObject([{ id: aId, childTotal: 0 }]);
    expect(await (await api.request('/api/tree')).json()).toEqual({
      tasks: [{ id: aId, parentId: null, title: 'A', columnId: 'todo', archivedAt: null }],
    });
    expect((await api.request(`/api/board/${bId}`)).status).toBe(404);
    expect((await api.request(`/api/breadcrumb/${bId}`)).status).toBe(404);
  });

  it('删除任务不需要 Content-Type（没有请求体）', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const response = await api.request(`/api/tasks/${aId}`, { method: 'DELETE' });

    expect(response.status).toBe(200);
  });

  it('任务不存在返回 404', async () => {
    const db = createTestDb();
    const api = createApp(db);

    const response = await remove(api, 'missing');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });

  it('父子成环的脏数据下递归能终止，整环都被删掉', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    // 手工造环，见 D17：接口层不可能产生这种数据，但删除不能因此死循环。
    db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(bId, aId);
    const api = createApp(db);

    const response = await remove(api, aId);

    expect(response.status).toBe(200);
    expect(remainingIds(db)).toEqual([]);
  });
});
