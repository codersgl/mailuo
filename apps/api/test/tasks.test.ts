import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb, insertTask } from './helpers.js';

const app = () => createApp(createTestDb());

function postTask(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchTask(app: ReturnType<typeof createApp>, id: string, body: unknown) {
  return app.request(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** UUID v4 的形状，规范要求 id 用 UUID v4 字符串。 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('POST /api/tasks', () => {
  it('建根任务返回 201 与完整字段，orders 从 1000 开始', async () => {
    const api = app();

    const response = await postTask(api, { columnId: 'todo', title: '写文档' });

    expect(response.status).toBe(201);
    const task = await response.json();
    expect(task).toMatchObject({
      parentId: null,
      columnId: 'todo',
      title: '写文档',
      description: '',
      duration: 0,
      orders: 1000,
      archivedAt: null,
    });
    expect(task.id).toMatch(UUID_V4);
    expect(task.createdAt).toBe(task.updatedAt);
  });

  it('同列追加取该列 MAX(orders) + 1000，不同列各自独立', async () => {
    const api = app();
    await postTask(api, { columnId: 'todo', title: 'A' });
    await postTask(api, { columnId: 'todo', title: 'B' });

    const third = await postTask(api, { columnId: 'doing', title: 'C' });

    expect((await third.json()).orders).toBe(1000);
    const board = await (await api.request('/api/board')).json();
    expect(board.columns[0].tasks.map((task: { title: string; orders: number }) => [task.title, task.orders])).toEqual([
      ['A', 1000],
      ['B', 2000],
    ]);
  });

  it('建子任务后出现在父看板，并计入父卡片进度', async () => {
    const api = app();
    const parent = await (await postTask(api, { columnId: 'todo', title: '父任务' })).json();
    const child = await (
      await postTask(api, { parentId: parent.id, columnId: 'done', title: '子任务' })
    ).json();

    expect(child.parentId).toBe(parent.id);
    const board = await (await api.request(`/api/board/${parent.id}`)).json();
    expect(board.parentId).toBe(parent.id);
    expect(board.columns[2].tasks.map((task: { id: string }) => task.id)).toEqual([child.id]);
    const rootBoard = await (await api.request('/api/board')).json();
    expect(rootBoard.columns[0].tasks[0]).toMatchObject({ childTotal: 1, childDone: 1 });
  });

  it('orders 只在自己父任务的目标列内计算', async () => {
    const db = createTestDb();
    const parentA = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const parentB = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    // A 的待办列里已有一个 orders 很大的子任务，它不该影响别的父任务或根层
    insertTask(db, { title: 'A 的子任务', columnId: 'todo', orders: 5000, parentId: parentA });
    const api = createApp(db);

    const childOfB = await (
      await postTask(api, { parentId: parentB, columnId: 'todo', title: 'B 的子任务' })
    ).json();
    const newRoot = await (await postTask(api, { columnId: 'todo', title: '新根任务' })).json();

    expect(childOfB.orders).toBe(1000);
    // 根层当前最大是 B 的 2000，而不是 A 的子任务的 5000
    expect(newRoot.orders).toBe(3000);
  });

  it('已归档任务仍参与 orders 计算，取消归档后不会插队', async () => {
    const db = createTestDb();
    insertTask(db, { title: '归档任务', columnId: 'todo', orders: 9000, archived: true });

    const response = await postTask(createApp(db), { columnId: 'todo', title: '新任务' });

    expect((await response.json()).orders).toBe(10000);
  });

  it('标题两端空格被去掉', async () => {
    const response = await postTask(app(), { columnId: 'todo', title: '  写文档  ' });

    expect((await response.json()).title).toBe('写文档');
  });

  it('标题为空或全是空格返回 400', async () => {
    const api = app();

    for (const title of ['', '   ']) {
      const response = await postTask(api, { columnId: 'todo', title });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'title: 标题不能为空' });
    }
  });

  it('缺标题或标题类型不对返回 400', async () => {
    const api = app();

    const missing = await postTask(api, { columnId: 'todo' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'title: 标题必须是字符串' });

    const wrongType = await postTask(api, { columnId: 'todo', title: 42 });
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toEqual({ error: 'title: 标题必须是字符串' });
  });

  it('未知字段返回 400，不会被静默丢弃', async () => {
    const response = await postTask(app(), { columnId: 'todo', title: 'A', titel: 'B' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '存在未定义的字段' });
  });

  it('列不存在返回 400', async () => {
    const response = await postTask(app(), { columnId: '不存在的列', title: 'A' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '列不存在: 不存在的列' });
  });

  it('父任务不存在返回 404', async () => {
    const response = await postTask(app(), { parentId: '不存在的任务', columnId: 'todo', title: 'A' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '父任务不存在' });
  });

  it('列与父任务同时非法时先报列错误', async () => {
    const response = await postTask(app(), {
      parentId: '不存在的任务',
      columnId: '不存在的列',
      title: 'A',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '列不存在: 不存在的列' });
  });

  it('Content-Type 不是 JSON 时给出明确提示', async () => {
    const response = await createApp(createTestDb()).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'title=A&columnId=todo',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Content-Type 必须是 application/json' });
  });

  it('父任务已归档返回 400', async () => {
    const db = createTestDb();
    const archivedParentId = insertTask(db, {
      title: '已归档父任务',
      columnId: 'todo',
      orders: 1000,
      archived: true,
    });

    const response = await postTask(createApp(db), {
      parentId: archivedParentId,
      columnId: 'todo',
      title: 'A',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '父任务已归档' });
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('改标题、描述、工期，只动传入的字段', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '原标题', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const response = await patchTask(api, id, { title: '  新标题  ', duration: 3 });

    expect(response.status).toBe(200);
    // 写接口统一返回 { task, columnTasks }，columnTasks 是该任务所在列的完整有序列表
    const { task, columnTasks } = await response.json();
    expect(task).toMatchObject({
      id,
      title: '新标题',
      duration: 3,
      // 没传的字段保持原值
      description: '',
      columnId: 'todo',
      orders: 1000,
    });
    expect(task.updatedAt > task.createdAt).toBe(true);
    expect(columnTasks.map((item: { id: string }) => item.id)).toEqual([id]);
  });

  it('新值与旧值相同时也刷新 updatedAt，而不是返回 404', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '任务', columnId: 'todo', orders: 1000 });

    const response = await patchTask(createApp(db), id, { title: '任务' });

    expect(response.status).toBe(200);
    const { task } = await response.json();
    expect(task.title).toBe('任务');
    expect(task.updatedAt > task.createdAt).toBe(true);
  });

  it('描述可以清空', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '任务', columnId: 'todo', orders: 1000 });
    db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run('原描述', id);

    const response = await patchTask(createApp(db), id, { description: '' });

    expect(response.status).toBe(200);
    expect((await response.json()).task.description).toBe('');
  });

  it('空对象返回 400', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '任务', columnId: 'todo', orders: 1000 });

    const response = await patchTask(createApp(db), id, {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: '没有需要修改的字段' });
  });

  it('工期非法返回 400', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '任务', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    for (const [duration, expected] of [
      [-1, 'duration: 工期不能为负'],
      [1.5, 'duration: 工期必须是整数'],
      ['3', 'duration: 工期必须是数字'],
    ] as const) {
      const response = await patchTask(api, id, { duration });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expected });
    }
  });

  it('任务不存在返回 404', async () => {
    const response = await patchTask(app(), '不存在的任务', { title: 'A' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });

  it('请求体不是合法 JSON 时返回 400 与统一错误体', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '任务', columnId: 'todo', orders: 1000 });

    const response = await createApp(db).request(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{不是 JSON',
    });

    expect(response.status).toBe(400);
    // Hono 自己抛的 HTTPException 只带 text/plain，这里必须被包成 { error: string }
    expect(await response.json()).toEqual({ error: '请求体不是合法 JSON' });
  });
});
