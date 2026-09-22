import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb, insertTask } from './helpers.js';

describe('GET /api/health', () => {
  it('返回 ok', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/board', () => {
  it('返回三列，按列分组并保持列内 orders 升序', async () => {
    const db = createTestDb();
    insertTask(db, { title: '后建的待办', columnId: 'todo', orders: 2000 });
    insertTask(db, { title: '先建的待办', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '进行中的任务', columnId: 'doing', orders: 1000 });
    const app = createApp(db);

    const response = await app.request('/api/board');

    expect(response.status).toBe(200);
    const board = await response.json();
    expect(board.parentId).toBeNull();
    expect(board.columns.map((column: { name: string }) => column.name)).toEqual([
      '待办',
      '进行中',
      '完成',
    ]);
    expect(board.columns[0].tasks.map((task: { title: string }) => task.title)).toEqual([
      '先建的待办',
      '后建的待办',
    ]);
    expect(board.columns[1].tasks.map((task: { title: string }) => task.title)).toEqual([
      '进行中的任务',
    ]);
    expect(board.columns[2].tasks).toEqual([]);
  });

  it('子任务计数只算未归档的直接子任务', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '子任务完成', columnId: 'done', orders: 1000, parentId });
    insertTask(db, { title: '子任务完成2', columnId: 'done', orders: 2000, parentId });
    insertTask(db, { title: '子任务待办', columnId: 'todo', orders: 3000, parentId });
    insertTask(db, { title: '已归档子任务', columnId: 'done', orders: 4000, parentId, archived: true });
    // 孙任务不计入父任务的进度：单层统计。
    const childId = insertTask(db, { title: '子任务进行中', columnId: 'doing', orders: 5000, parentId });
    insertTask(db, { title: '孙任务完成', columnId: 'done', orders: 1000, parentId: childId });
    const app = createApp(db);

    const response = await app.request('/api/board');
    const board = await response.json();
    const parent = board.columns[0].tasks.find((task: { id: string }) => task.id === parentId);

    expect(parent.childTotal).toBe(4);
    expect(parent.childDone).toBe(2);
    // 子任务本身不是根任务，不出现在根看板的第一层。
    expect(board.columns.flatMap((column: { tasks: unknown[] }) => column.tasks)).toHaveLength(1);
  });

  it('已归档的根任务不出现', async () => {
    const db = createTestDb();
    insertTask(db, { title: '正常任务', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '已归档任务', columnId: 'todo', orders: 2000, archived: true });
    const app = createApp(db);

    const response = await app.request('/api/board');
    const board = await response.json();

    expect(board.columns[0].tasks.map((task: { title: string }) => task.title)).toEqual(['正常任务']);
  });

  it('空库返回三列空数组', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/board');
    const board = await response.json();

    expect(board.columns).toHaveLength(3);
    expect(board.columns.every((column: { tasks: unknown[] }) => column.tasks.length === 0)).toBe(true);
  });
});

describe('未知路径', () => {
  it('返回 404 与统一错误体', async () => {
    const app = createApp(createTestDb());

    const response = await app.request('/api/不存在');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  });
});
