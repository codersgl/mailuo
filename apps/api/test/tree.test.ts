import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { readBreadcrumb } from '../src/repositories/tasks.js';
import { createTestDb, insertTask } from './helpers.js';

describe('GET /api/board/:parentId', () => {
  it('返回子看板，只含该层任务并按列分组', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'doing', orders: 1000 });
    insertTask(db, { title: '子任务待办', columnId: 'todo', orders: 1000, parentId });
    insertTask(db, { title: '子任务完成', columnId: 'done', orders: 1000, parentId });

    const response = await createApp(db).request(`/api/board/${parentId}`);

    expect(response.status).toBe(200);
    const board = await response.json();
    expect(board.parentId).toBe(parentId);
    expect(
      board.columns.map((column: { id: string; tasks: Array<{ title: string }> }) => [
        column.id,
        column.tasks.map((task) => task.title),
      ]),
    ).toEqual([
      ['todo', ['子任务待办']],
      ['doing', []],
      ['done', ['子任务完成']],
    ]);
  });

  it('任务不存在返回 404', async () => {
    const response = await createApp(createTestDb()).request('/api/board/不存在的任务');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });
});

describe('GET /api/tree', () => {
  it('一次返回全部未归档任务，字段只有 id/parentId/title/columnId', async () => {
    const db = createTestDb();
    const rootId = insertTask(db, { title: '根任务', columnId: 'todo', orders: 1000 });
    const childId = insertTask(db, { title: '子任务', columnId: 'doing', orders: 1000, parentId: rootId });
    insertTask(db, { title: '孙任务', columnId: 'done', orders: 1000, parentId: childId });
    insertTask(db, { title: '已归档任务', columnId: 'todo', orders: 2000, archived: true });

    const response = await createApp(db).request('/api/tree');

    expect(response.status).toBe(200);
    const { tasks } = await response.json();
    expect(tasks).toHaveLength(3);
    expect(tasks.map((task: { title: string }) => task.title).sort()).toEqual([
      '子任务',
      '孙任务',
      '根任务',
    ]);
    expect(tasks.find((task: { id: string }) => task.id === childId)).toEqual({
      id: childId,
      parentId: rootId,
      title: '子任务',
      columnId: 'doing',
    });
    expect(tasks.find((task: { id: string }) => task.id === rootId).parentId).toBeNull();
  });

  it('空库返回空数组', async () => {
    const response = await createApp(createTestDb()).request('/api/tree');

    expect(await response.json()).toEqual({ tasks: [] });
  });
});

describe('GET /api/breadcrumb/:taskId', () => {
  it('根任务的面包屑是「根看板 + 自己」', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '根任务', columnId: 'todo', orders: 1000 });

    const response = await createApp(db).request(`/api/breadcrumb/${id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { id: null, title: '根看板' },
        { id, title: '根任务' },
      ],
    });
  });

  it('多层任务按根到自身的顺序返回', async () => {
    const db = createTestDb();
    const rootId = insertTask(db, { title: '重构登录', columnId: 'todo', orders: 1000 });
    const childId = insertTask(db, { title: '前端部分', columnId: 'doing', orders: 1000, parentId: rootId });
    const leafId = insertTask(db, { title: '表单校验', columnId: 'todo', orders: 1000, parentId: childId });

    const response = await createApp(db).request(`/api/breadcrumb/${leafId}`);

    expect(await response.json()).toEqual({
      items: [
        { id: null, title: '根看板' },
        { id: rootId, title: '重构登录' },
        { id: childId, title: '前端部分' },
        { id: leafId, title: '表单校验' },
      ],
    });
  });

  it('任务不存在返回 404', async () => {
    const response = await createApp(createTestDb()).request('/api/breadcrumb/不存在的任务');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });

  it('父子关系成环时直接报错，不进入死循环', () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000, parentId: aId });
    // 正常接口不会造成这种数据，这里直接改库模拟脏数据。
    db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(bId, aId);

    expect(() => readBreadcrumb(db, bId)).toThrow(/成环/);
  });
});
