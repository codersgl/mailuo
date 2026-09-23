import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  TaskCycleError,
  TaskParentMissingError,
  readBreadcrumb,
} from '../src/repositories/tasks.js';
import {
  createTestDb,
  insertTask,
  readJson,
  type BoardBody,
  type TreeBody,
} from './helpers.js';
describe('GET /api/board/:parentId', () => {
  it('返回子看板，只含该层任务并按列分组', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'doing', orders: 1000 });
    insertTask(db, { title: '子任务待办', columnId: 'todo', orders: 1000, parentId });
    insertTask(db, { title: '子任务完成', columnId: 'done', orders: 1000, parentId });

    const response = await createApp(db).request(`/api/board/${parentId}`);

    expect(response.status).toBe(200);
    const board = await readJson<BoardBody>(response);
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
  it('一次返回全部未归档任务，字段含建树与工期提醒要用的那几项', async () => {
    const db = createTestDb();
    const rootId = insertTask(db, { title: '根任务', columnId: 'todo', orders: 1000 });
    const childId = insertTask(db, { title: '子任务', columnId: 'doing', orders: 1000, parentId: rootId });
    insertTask(db, { title: '孙任务', columnId: 'done', orders: 1000, parentId: childId });
    insertTask(db, { title: '已归档任务', columnId: 'todo', orders: 2000, archived: true });

    const response = await createApp(db).request('/api/tree');

    expect(response.status).toBe(200);
    const { tasks } = await readJson<TreeBody>(response);
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
      archivedAt: null,
      durationMinutes: null,
      spentMinutes: 0,
      runningSince: null,
    });
    expect(tasks.find((task: { id: string }) => task.id === rootId)!.parentId).toBeNull();
  });

  it('includeArchived=1 时归档节点带 archivedAt 返回', async () => {
    const db = createTestDb();
    const archivedId = insertTask(db, { title: '已归档任务', columnId: 'todo', orders: 1000, archived: true });

    const response = await createApp(db).request('/api/tree?includeArchived=1');

    const { tasks } = await readJson<TreeBody>(response);
    expect(tasks).toEqual([
      {
        id: archivedId,
        parentId: null,
        title: '已归档任务',
        columnId: 'todo',
        archivedAt: '2024-01-01T00:00:00.000Z',
        durationMinutes: null,
        spentMinutes: 0,
        runningSince: null,
      },
    ]);
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

    expect(() => readBreadcrumb(db, bId)).toThrow(TaskCycleError);
  });

  it('父行缺失时抛错，不假装成根任务', () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000, parentId: aId });
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 3000, parentId: bId });
    // 外键开启时删不掉被引用的父行，临时关掉来模拟脏数据。
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(bId);
    db.pragma('foreign_keys = ON');

    // 与成环同一类脏数据、同一个口径：undefined 只表示「这条任务不存在」。
    expect(() => readBreadcrumb(db, cId)).toThrow(TaskParentMissingError);
  });

  it('父行缺失的脏数据让面包屑接口回 500 并记日志，而不是 404 或一条假面包屑', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000, parentId: aId });
    const cId = insertTask(db, { title: 'C', columnId: 'todo', orders: 3000, parentId: bId });
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(bId);
    db.pragma('foreign_keys = ON');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await createApp(db).request(`/api/breadcrumb/${cId}`);

    // 404 会骗人（任务在、只是父链断了），静默截断会画出错误的面包屑；单条任务的读报 500 最诚实。
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '服务器内部错误' });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});
