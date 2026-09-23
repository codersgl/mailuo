import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
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

/** 读出某列下可见任务的标题顺序，用来断言重排结果。 */
async function columnTitles(app: App, parentId: string | null, columnId: string): Promise<string[]> {
  const path = parentId === null ? '/api/board' : `/api/board/${parentId}`;
  const board = await readJson<BoardBody>(await app.request(path));
  const column = board.columns.find((item: { id: string }) => item.id === columnId)!;
  return column.tasks.map((task: { title: string }) => task.title);
}

describe('PATCH /api/tasks/:id 移动', () => {
  it('同列内重排：重写该列 orders 并返回整列', async () => {
    const db = createTestDb();
    insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    insertTask(db, { title: 'C', columnId: 'todo', orders: 3000 });
    const dId = insertTask(db, { title: 'D', columnId: 'todo', orders: 4000 });
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${dId}`, { columnId: 'todo', position: 1 });

    expect(response.status).toBe(200);
    const { task, columnTasks } = await readJson<TaskMutationBody>(response);
    expect(task.orders).toBe(2000);
    expect(columnTasks.map((item: { title: string }) => item.title)).toEqual(['A', 'D', 'B', 'C']);
    expect(columnTasks.map((item: { orders: number }) => item.orders)).toEqual([1000, 2000, 3000, 4000]);
    expect(await columnTitles(api, null, 'todo')).toEqual(['A', 'D', 'B', 'C']);
  });

  it('position 0 插到最前，超出长度按末尾处理', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 3000 });
    const api = createApp(db);

    await patchJson(api, `/api/tasks/${cId}`, { columnId: 'todo', position: 0 });
    expect(await columnTitles(api, null, 'todo')).toEqual(['C', 'A', 'B']);

    await patchJson(api, `/api/tasks/${aId}`, { columnId: 'todo', position: 99 });
    expect(await columnTitles(api, null, 'todo')).toEqual(['C', 'B', 'A']);
  });

  it('跨列移动：从原列消失，出现在目标列指定位置', async () => {
    const db = createTestDb();
    const movingId = insertTask(db, { title: '待办任务', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '进行中一', columnId: 'doing', orders: 1000 });
    insertTask(db, { title: '进行中二', columnId: 'doing', orders: 2000 });
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${movingId}`, {
      columnId: 'doing',
      position: 1,
    });

    const { task, columnTasks } = await readJson<TaskMutationBody>(response);
    expect(task.columnId).toBe('doing');
    expect(columnTasks.map((item: { title: string }) => item.title)).toEqual([
      '进行中一',
      '待办任务',
      '进行中二',
    ]);
    expect(await columnTitles(api, null, 'todo')).toEqual([]);
  });

  it('重排只影响目标父任务的目标列，不动其他层', async () => {
    const db = createTestDb();
    const rootA = insertTask(db, { title: '根A', columnId: 'todo', orders: 1000 });
    const rootB = insertTask(db, { title: '根B', columnId: 'todo', orders: 2000 });
    const parentId = insertTask(db, { title: '父任务', columnId: 'doing', orders: 1000 });
    insertTask(db, { title: '子一', columnId: 'todo', orders: 1000, parentId });
    const childTwoId = insertTask(db, { title: '子二', columnId: 'todo', orders: 2000, parentId });
    const api = createApp(db);

    await patchJson(api, `/api/tasks/${childTwoId}`, { columnId: 'todo', position: 0 });

    // 根层的两个任务 orders 不变
    const board = await readJson<BoardBody>(await api.request('/api/board'));
    const rootTasks = board.columns[0]!.tasks;
    expect(rootTasks.map((task: { id: string; orders: number }) => [task.id, task.orders])).toEqual([
      [rootA, 1000],
      [rootB, 2000],
    ]);
    expect(await columnTitles(api, parentId, 'todo')).toEqual(['子二', '子一']);
  });

  it('已归档任务不参与重排，保留原 orders', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const archivedId = insertTask(db, { title: '归档任务', columnId: 'todo', orders: 5000, archived: true });
    insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const api = createApp(db);

    await patchJson(api, `/api/tasks/${aId}`, { columnId: 'todo', position: 1 });

    expect(await columnTitles(api, null, 'todo')).toEqual(['B', 'A']);
    const archivedOrders = db
      .prepare('SELECT orders FROM tasks WHERE id = ?')
      .get(archivedId) as { orders: number };
    expect(archivedOrders.orders).toBe(5000);
  });

  it('移动与字段更新可以同时提交', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '旧标题', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${id}`, {
      title: '新标题',
      durationMinutes: 2,
      columnId: 'doing',
      position: 0,
    });

    const { task } = await readJson<TaskMutationBody>(response);
    expect(task).toMatchObject({
      title: '新标题',
      durationMinutes: 2,
      columnId: 'doing',
      orders: 1000,
    });
  });

  it('只给一个移动参数返回 400', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    for (const body of [{ columnId: 'doing' }, { position: 0 }]) {
      const response = await patchJson(api, `/api/tasks/${id}`, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: '移动必须同时提供 columnId 与 position' });
    }
  });

  it('目标列不存在返回 400', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });

    const response = await patchJson(createApp(db), `/api/tasks/${id}`, {
      columnId: '不存在的列',
      position: 0,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '列不存在: 不存在的列' });
  });

  it('任务不存在返回 404', async () => {
    const response = await patchJson(createApp(createTestDb()), '/api/tasks/不存在的任务', {
      columnId: 'doing',
      position: 0,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });
});

describe('PATCH /api/tasks/:id/parent', () => {
  it('挂到新父任务下，追加到目标列末尾', async () => {
    const db = createTestDb();
    const taskId = insertTask(db, { title: '任务', columnId: 'todo', orders: 1000 });
    const newParentId = insertTask(db, { title: '新父任务', columnId: 'todo', orders: 2000 });
    insertTask(db, { title: '已有子任务', columnId: 'doing', orders: 4000, parentId: newParentId });
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${taskId}/parent`, {
      parentId: newParentId,
      columnId: 'doing',
    });

    expect(response.status).toBe(200);
    const { task, columnTasks } = await readJson<TaskMutationBody>(response);
    expect(task).toMatchObject({ parentId: newParentId, columnId: 'doing', orders: 5000 });
    expect(columnTasks.map((item: { title: string }) => item.title)).toEqual(['已有子任务', '任务']);
  });

  it('可以移回根看板', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'todo', orders: 1000 });
    const childId = insertTask(db, { title: '子任务', columnId: 'todo', orders: 1000, parentId });
    insertTask(db, { title: '根任务', columnId: 'doing', orders: 1000 });
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${childId}/parent`, {
      parentId: null,
      columnId: 'doing',
    });

    const { task } = await readJson<TaskMutationBody>(response);
    expect(task).toMatchObject({ parentId: null, columnId: 'doing', orders: 2000 });
    expect(await columnTitles(api, null, 'doing')).toEqual(['根任务', '子任务']);
    expect(await columnTitles(api, parentId, 'todo')).toEqual([]);
  });

  it('挂到自己或自己的后代下返回 400', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 1000, parentId: bId });
    const api = createApp(db);

    for (const parentId of [aId, bId, cId]) {
      const response = await patchJson(api, `/api/tasks/${aId}/parent`, {
        parentId,
        columnId: 'todo',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: '不能把任务挂到自己或自己的后代下' });
    }
  });

  it('子树跟随移动', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId: aId });
    const newParentId = insertTask(db, { title: '新父任务', columnId: 'todo', orders: 2000 });
    const api = createApp(db);

    await patchJson(api, `/api/tasks/${aId}/parent`, { parentId: newParentId, columnId: 'todo' });

    const { tasks } = await readJson<TreeBody>(await api.request('/api/tree'));
    expect(tasks.find((task: { id: string }) => task.id === bId)!.parentId).toBe(aId);
  });

  it('挂到同一个父任务的同一列等价于追加到列末尾', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 1000, parentId });
    insertTask(db, { title: 'C', columnId: 'todo', orders: 2000, parentId });
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${bId}/parent`, {
      parentId,
      columnId: 'todo',
    });

    const { task } = await readJson<TaskMutationBody>(response);
    expect(task.orders).toBe(3000);
    expect(await columnTitles(api, parentId, 'todo')).toEqual(['C', 'B']);
  });

  it('父任务不存在返回 404，父任务已归档返回 400，列不存在返回 400', async () => {
    const db = createTestDb();
    const taskId = insertTask(db, { title: '任务', columnId: 'todo', orders: 1000 });
    const archivedId = insertTask(db, {
      title: '归档任务',
      columnId: 'todo',
      orders: 2000,
      archived: true,
    });
    const api = createApp(db);

    const notFound = await patchJson(api, `/api/tasks/${taskId}/parent`, {
      parentId: '不存在的任务',
      columnId: 'todo',
    });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: '父任务不存在' });

    const archived = await patchJson(api, `/api/tasks/${taskId}/parent`, {
      parentId: archivedId,
      columnId: 'todo',
    });
    expect(archived.status).toBe(400);
    expect(await archived.json()).toEqual({ error: '父任务已归档' });

    const badColumn = await patchJson(api, `/api/tasks/${taskId}/parent`, {
      parentId: null,
      columnId: '不存在的列',
    });
    expect(badColumn.status).toBe(400);
    expect(await badColumn.json()).toEqual({ error: '列不存在: 不存在的列' });
  });

  it('任务不存在返回 404', async () => {
    const response = await patchJson(createApp(createTestDb()), '/api/tasks/不存在的任务/parent', {
      parentId: null,
      columnId: 'todo',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });
});

describe('移动的边界与回归', () => {
  it('跨列移动不动源列其他任务的 orders', async () => {
    const db = createTestDb();
    const movingId = insertTask(db, { title: '要移动', columnId: 'todo', orders: 2000 });
    insertTask(db, { title: '留在原列一', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '留在原列二', columnId: 'todo', orders: 3000 });
    const api = createApp(db);

    await patchJson(api, `/api/tasks/${movingId}`, { columnId: 'doing', position: 0 });

    const board = await readJson<BoardBody>(await api.request('/api/board'));
    const todo = board.columns.find((column: { id: string }) => column.id === 'todo')!;
    expect(todo.tasks.map((task: { title: string; orders: number }) => [task.title, task.orders])).toEqual([
      ['留在原列一', 1000],
      ['留在原列二', 3000],
    ]);
  });

  it('放到原位是空操作，不刷新任何任务的 updatedAt', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    const readUpdatedAt = (id: string) =>
      (db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(id) as { updated_at: string })
        .updated_at;
    const beforeA = readUpdatedAt(aId);
    const beforeB = readUpdatedAt(bId);
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${bId}`, { columnId: 'todo', position: 1 });

    expect(response.status).toBe(200);
    expect(readUpdatedAt(aId)).toBe(beforeA);
    expect(readUpdatedAt(bId)).toBe(beforeB);
  });

  it('columnTasks 与看板卡片同构，带直接子任务计数', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'todo', orders: 1000 });
    const childId = insertTask(db, { title: '子任务', columnId: 'done', orders: 1000, parentId });
    insertTask(db, { title: '子任务待办', columnId: 'todo', orders: 2000, parentId });
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${childId}`, { columnId: 'done', position: 0 });

    const { columnTasks } = await readJson<TaskMutationBody>(response);
    expect(columnTasks[0]!).toMatchObject({ id: childId, childTotal: 0, childDone: 0 });
    const board = await readJson<BoardBody>(await api.request('/api/board'));
    expect(board.columns[0]!.tasks[0]!).toMatchObject({ id: parentId, childTotal: 2, childDone: 1 });
  });

  it('已归档任务不能被移动或改字段', async () => {
    const db = createTestDb();
    const archivedId = insertTask(db, {
      title: '归档任务',
      columnId: 'todo',
      orders: 5000,
      archived: true,
    });
    const api = createApp(db);

    const moved = await patchJson(api, `/api/tasks/${archivedId}`, {
      columnId: 'todo',
      position: 0,
    });
    expect(moved.status).toBe(400);
    expect(await moved.json()).toEqual({ error: '任务已归档' });

    const renamed = await patchJson(api, `/api/tasks/${archivedId}`, { title: '改名' });
    expect(renamed.status).toBe(400);
    expect(await renamed.json()).toEqual({ error: '任务已归档' });

    const archivedOrders = db
      .prepare('SELECT orders FROM tasks WHERE id = ?')
      .get(archivedId) as { orders: number };
    expect(archivedOrders.orders).toBe(5000);
  });

  it('未知字段返回 400', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });

    const response = await patchJson(createApp(db), `/api/tasks/${id}`, { titel: 'B' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '存在未定义的字段' });
  });

  it('任务不存在优先于列不存在', async () => {
    const response = await patchJson(createApp(createTestDb()), '/api/tasks/不存在的任务', {
      columnId: '不存在的列',
      position: 0,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });
});

describe('改父级的边界与回归', () => {
  it('环被拒绝后库没有任何改动', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'doing', orders: 2000, parentId: aId });
    const cId = insertTask(db, { title: 'C', columnId: 'done', orders: 3000, parentId: bId });
    const api = createApp(db);

    const response = await patchJson(api, `/api/tasks/${aId}/parent`, {
      parentId: cId,
      columnId: 'done',
    });

    expect(response.status).toBe(400);
    const rows = db
      .prepare('SELECT id, parent_id, column_id, orders FROM tasks ORDER BY id')
      .all() as Array<{ id: string; parent_id: string | null; column_id: string; orders: number }>;
    expect(rows).toEqual([
      { id: aId, parent_id: null, column_id: 'todo', orders: 1000 },
      { id: bId, parent_id: aId, column_id: 'doing', orders: 2000 },
      { id: cId, parent_id: bId, column_id: 'done', orders: 3000 },
    ]);
  });

  it('缺少 parentId 时给出明确提示', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });

    const response = await patchJson(createApp(db), `/api/tasks/${id}/parent`, {
      columnId: 'todo',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'parentId: 不能为空，移到根看板请传 null',
    });
  });

  it('未知字段返回 400，已归档任务不能被改父级', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const archivedId = insertTask(db, {
      title: '归档任务',
      columnId: 'todo',
      orders: 2000,
      archived: true,
    });
    const api = createApp(db);

    const extra = await patchJson(api, `/api/tasks/${id}/parent`, {
      parentId: null,
      columnId: 'todo',
      orders: 1,
    });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({ error: '存在未定义的字段' });

    const archived = await patchJson(api, `/api/tasks/${archivedId}/parent`, {
      parentId: null,
      columnId: 'todo',
    });
    expect(archived.status).toBe(400);
    expect(await archived.json()).toEqual({ error: '任务已归档' });
  });

  it('任务不存在优先于列不存在', async () => {
    const response = await patchJson(createApp(createTestDb()), '/api/tasks/不存在的任务/parent', {
      parentId: null,
      columnId: '不存在的列',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });
});
