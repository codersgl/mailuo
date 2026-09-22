import { describe, expect, it } from 'vitest';
import { readBoard } from '../src/repositories/board.js';
import { createTestDb, insertTask } from './helpers.js';

/**
 * 仓储层测试：`GET /api/board/:parentId` 路由要等导航那一步才接入，
 * 这里直接调 readBoard 覆盖子看板分支，避免这段 SQL 在接路由前完全没有回归保护。
 */
describe('readBoard', () => {
  it('子看板只返回该层的任务，并按列分组', () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'doing', orders: 1000 });
    const childDone = insertTask(db, { title: '子任务完成', columnId: 'done', orders: 1000, parentId });
    const childTodo = insertTask(db, { title: '子任务待办', columnId: 'todo', orders: 2000, parentId });
    insertTask(db, { title: '孙任务完成', columnId: 'done', orders: 1000, parentId: childDone });

    // 根看板只有父任务一个卡片
    const root = readBoard(db, null);
    expect(root.parentId).toBeNull();
    expect(flattenTitles(root)).toEqual(['父任务']);
    // 进度只算直接子任务：两个未归档子任务，其中完成列一个；孙任务不计入
    expect(root.columns[1]!.tasks[0]).toMatchObject({ childTotal: 2, childDone: 1 });

    const child = readBoard(db, parentId);
    expect(child.parentId).toBe(parentId);
    expect(child.columns.map((column) => [column.id, column.tasks.map((task) => task.title)])).toEqual([
      ['todo', ['子任务待办']],
      ['doing', []],
      ['done', ['子任务完成']],
    ]);
    // 卡片上的进度是它自己的直接子任务，与父任务无关
    const doneTask = child.columns[2]!.tasks[0]!;
    expect(doneTask).toMatchObject({ id: childDone, childTotal: 1, childDone: 1 });
    expect(child.columns[0]!.tasks[0]).toMatchObject({ id: childTodo, childTotal: 0, childDone: 0 });
  });

  it('看板卡片带上工期字段，三种状态都能读出来', () => {
    const db = createTestDb();
    insertTask(db, { title: '未估', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '瞬时', columnId: 'todo', orders: 2000, durationMinutes: 0 });
    insertTask(db, { title: '九十分钟', columnId: 'todo', orders: 3000, durationMinutes: 90 });

    const board = readBoard(db, null);

    // 这条断言盯的是 SELECT 列表：漏掉 t.duration_minutes 时前端会收到 undefined，
    // 卡片 chip 会显示成「工期 」这种没有数字的文案。
    expect(board.columns[0]!.tasks.map((task) => [task.title, task.durationMinutes])).toEqual([
      ['未估', null],
      ['瞬时', 0],
      ['九十分钟', 90],
    ]);
  });

  it('子看板同样过滤已归档子任务', () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '正常子任务', columnId: 'todo', orders: 1000, parentId });
    insertTask(db, { title: '已归档子任务', columnId: 'todo', orders: 2000, parentId, archived: true });

    const child = readBoard(db, parentId);

    expect(flattenTitles(child)).toEqual(['正常子任务']);
  });

  it('父任务 id 不存在时返回该层的空看板', () => {
    const db = createTestDb();

    const board = readBoard(db, '不存在的任务');

    expect(board.parentId).toBe('不存在的任务');
    expect(board.columns).toHaveLength(3);
    expect(board.columns.every((column) => column.tasks.length === 0)).toBe(true);
  });
});

function flattenTitles(board: { columns: Array<{ tasks: Array<{ title: string }> }> }): string[] {
  return board.columns.flatMap((column) => column.tasks.map((task) => task.title));
}
