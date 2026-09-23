import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { DependencyCycleError, computeSchedule } from '../src/domain/cpm.js';
import { createTestDb, insertTask } from './helpers.js';

type App = ReturnType<typeof createApp>;

function addDep(db: Db, predecessorId: string, successorId: string) {
  db.prepare('INSERT INTO task_deps (predecessor_id, successor_id) VALUES (?, ?)').run(
    predecessorId,
    successorId,
  );
}

/** 按 id 找节点，断言时不用关心节点的排列次序。 */
function node(body: { nodes: Array<{ id: string }> }, id: string) {
  const found = body.nodes.find((item) => item.id === id);
  if (!found) throw new Error(`结果里没有节点: ${id}`);
  return found;
}

describe('computeSchedule（纯计算）', () => {
  it('线性链：全部任务都是关键任务，项目工期是最后一个任务的完成时间', () => {
    const schedule = computeSchedule(
      [
        { id: 'a', durationMinutes: 60 },
        { id: 'b', durationMinutes: 120 },
        { id: 'c', durationMinutes: 30 },
      ],
      [
        { predecessorId: 'a', successorId: 'b' },
        { predecessorId: 'b', successorId: 'c' },
      ],
    );

    expect(schedule.projectDuration).toBe(210);
    expect(schedule.tasks).toEqual([
      { id: 'a', earliestStart: 0, earliestFinish: 60, latestStart: 0, latestFinish: 60, slack: 0, critical: true },
      { id: 'b', earliestStart: 60, earliestFinish: 180, latestStart: 60, latestFinish: 180, slack: 0, critical: true },
      { id: 'c', earliestStart: 180, earliestFinish: 210, latestStart: 180, latestFinish: 210, slack: 0, critical: true },
    ]);
    expect(schedule.edges).toEqual([
      { predecessorId: 'a', successorId: 'b', critical: true },
      { predecessorId: 'b', successorId: 'c', critical: true },
    ]);
  });

  it('分支：短分支有松弛时间，边也只关键在其中一条上', () => {
    const schedule = computeSchedule(
      [
        { id: 'a', durationMinutes: 100 },
        { id: 'b', durationMinutes: 30 },
        { id: 'c', durationMinutes: 10 },
      ],
      [
        { predecessorId: 'a', successorId: 'c' },
        { predecessorId: 'b', successorId: 'c' },
      ],
    );

    expect(schedule.projectDuration).toBe(110);
    expect(schedule.tasks).toEqual([
      { id: 'a', earliestStart: 0, earliestFinish: 100, latestStart: 0, latestFinish: 100, slack: 0, critical: true },
      { id: 'b', earliestStart: 0, earliestFinish: 30, latestStart: 70, latestFinish: 100, slack: 70, critical: false },
      { id: 'c', earliestStart: 100, earliestFinish: 110, latestStart: 100, latestFinish: 110, slack: 0, critical: true },
    ]);
    expect(schedule.edges).toEqual([
      { predecessorId: 'a', successorId: 'c', critical: true },
      { predecessorId: 'b', successorId: 'c', critical: false },
    ]);
  });

  it('未估工期（null）按 0 参与计算', () => {
    const schedule = computeSchedule(
      [
        { id: 'a', durationMinutes: null },
        { id: 'b', durationMinutes: 60 },
      ],
      [{ predecessorId: 'a', successorId: 'b' }],
    );

    expect(schedule.projectDuration).toBe(60);
    expect(schedule.tasks[0]).toMatchObject({ earliestFinish: 0, slack: 0, critical: true });
    expect(schedule.tasks[1]).toMatchObject({ earliestStart: 0, earliestFinish: 60 });
  });

  it('0 工期是瞬时任务，不阻断关键路径传递', () => {
    const schedule = computeSchedule(
      [
        { id: 'a', durationMinutes: 0 },
        { id: 'b', durationMinutes: 0 },
      ],
      [{ predecessorId: 'a', successorId: 'b' }],
    );

    expect(schedule.projectDuration).toBe(0);
    expect(schedule.tasks.every((task) => task.critical)).toBe(true);
  });

  it('关键任务之间仍可能有一条不关键的边', () => {
    // p 通过 t→v 这条链成为关键任务（v 是决定工期的终点）；p→s 是紧的但 s 有松弛，
    // 所以这条边不在任何关键路径上。
    const schedule = computeSchedule(
      [
        { id: 'p', durationMinutes: 10 },
        { id: 't', durationMinutes: 100 },
        { id: 's', durationMinutes: 0 },
      ],
      [
        { predecessorId: 'p', successorId: 't' },
        { predecessorId: 'p', successorId: 's' },
      ],
    );

    expect(schedule.projectDuration).toBe(110);
    expect(schedule.tasks.map((task) => [task.id, task.critical, task.slack])).toEqual([
      ['p', true, 0],
      ['t', true, 0],
      ['s', false, 100],
    ]);
    expect(schedule.edges).toEqual([
      { predecessorId: 'p', successorId: 't', critical: true },
      { predecessorId: 'p', successorId: 's', critical: false },
    ]);
  });

  it('两个关键任务之间也可能有一条不紧的边', () => {
    // p 与 s 都关键，但 p→s 上 p 的最早完成时间早于 s 的最早开始时间：
    // 让 s 变关键的是 q，p 只是通过 t→v 这条链关键。
    const schedule = computeSchedule(
      [
        { id: 'p', durationMinutes: 10 },
        { id: 'q', durationMinutes: 30 },
        { id: 't', durationMinutes: 0 },
        { id: 'v', durationMinutes: 20 },
        { id: 's', durationMinutes: 0 },
      ],
      [
        { predecessorId: 'p', successorId: 't' },
        { predecessorId: 't', successorId: 'v' },
        { predecessorId: 'p', successorId: 's' },
        { predecessorId: 'q', successorId: 's' },
      ],
    );

    expect(schedule.projectDuration).toBe(30);
    expect(schedule.tasks.every((task) => task.critical)).toBe(true);
    expect(schedule.edges.find((edge) => edge.successorId === 's' && edge.predecessorId === 'p')).toEqual({
      predecessorId: 'p',
      successorId: 's',
      critical: false,
    });
  });

  it('孤立任务：没有依赖时松弛时间等于项目工期', () => {
    const schedule = computeSchedule(
      [
        { id: 'a', durationMinutes: 60 },
        { id: 'b', durationMinutes: 10 },
      ],
      [],
    );

    expect(schedule.projectDuration).toBe(60);
    expect(schedule.tasks[0]).toMatchObject({ earliestStart: 0, latestStart: 0, slack: 0, critical: true });
    expect(schedule.tasks[1]).toMatchObject({ earliestStart: 0, latestStart: 50, slack: 50, critical: false });
  });

  it('空输入返回空结果与 0 工期', () => {
    expect(computeSchedule([], [])).toEqual({ projectDuration: 0, tasks: [], edges: [] });
  });

  it('两端不在节点集合里的边被丢弃', () => {
    const schedule = computeSchedule(
      [{ id: 'a', durationMinutes: 10 }],
      [
        { predecessorId: 'a', successorId: '不存在' },
        { predecessorId: '不存在', successorId: 'a' },
      ],
    );

    expect(schedule.edges).toEqual([]);
    expect(schedule.tasks).toEqual([
      { id: 'a', earliestStart: 0, earliestFinish: 10, latestStart: 0, latestFinish: 10, slack: 0, critical: true },
    ]);
  });

  it('重复的节点与边只算一次', () => {
    const schedule = computeSchedule(
      [
        { id: 'a', durationMinutes: 10 },
        { id: 'a', durationMinutes: 999 },
        { id: 'b', durationMinutes: 10 },
      ],
      [
        { predecessorId: 'a', successorId: 'b' },
        { predecessorId: 'a', successorId: 'b' },
      ],
    );

    expect(schedule.tasks.map((task) => task.id)).toEqual(['a', 'b']);
    expect(schedule.edges).toHaveLength(1);
    expect(schedule.projectDuration).toBe(20);
  });

  it('成环时抛 DependencyCycleError', () => {
    expect(() =>
      computeSchedule(
        [
          { id: 'a', durationMinutes: 1 },
          { id: 'b', durationMinutes: 1 },
        ],
        [
          { predecessorId: 'a', successorId: 'b' },
          { predecessorId: 'b', successorId: 'a' },
        ],
      ),
    ).toThrow(DependencyCycleError);
  });
});

describe('GET /api/board/cpm', () => {
  it('根看板：返回节点、边、总工期与关键路径', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000, durationMinutes: 60 });
    const bId = insertTask(db, { title: 'B', columnId: 'doing', orders: 1000, durationMinutes: 120 });
    const cId = insertTask(db, { title: 'C', columnId: 'done', orders: 1000, durationMinutes: 30 });
    addDep(db, aId, bId);
    addDep(db, bId, cId);
    const api = createApp(db);

    const response = await api.request('/api/board/cpm');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.parentId).toBeNull();
    expect(body.projectDuration).toBe(210);
    // 节点顺序跟着看板走：列序 + 列内 orders。
    expect(body.nodes.map((item: { id: string }) => item.id)).toEqual([aId, bId, cId]);
    expect(node(body, aId)).toMatchObject({
      title: 'A',
      columnId: 'todo',
      durationMinutes: 60,
      archivedAt: null,
      earliestStart: 0,
      earliestFinish: 60,
      latestStart: 0,
      latestFinish: 60,
      slack: 0,
      critical: true,
    });
    expect(node(body, cId)).toMatchObject({ earliestStart: 180, earliestFinish: 210, critical: true });
    expect(body.edges).toEqual([
      { predecessorId: aId, successorId: bId, critical: true },
      { predecessorId: bId, successorId: cId, critical: true },
    ]);
  });

  it('分支：短分支的松弛时间与关键标记与纯计算一致', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000, durationMinutes: 100 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000, durationMinutes: 30 });
    const cId = insertTask(db, { title: 'C', columnId: 'done', orders: 1000, durationMinutes: 10 });
    addDep(db, aId, cId);
    addDep(db, bId, cId);
    const api = createApp(db);

    const body = await (await api.request('/api/board/cpm')).json();

    expect(body.projectDuration).toBe(110);
    expect(node(body, bId)).toMatchObject({ slack: 70, critical: false });
    expect(body.edges).toEqual([
      { predecessorId: aId, successorId: cId, critical: true },
      { predecessorId: bId, successorId: cId, critical: false },
    ]);
  });

  it('未估工期在响应里保持 null，但按 0 参与计算', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: '未估', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000, durationMinutes: 60 });
    addDep(db, aId, bId);
    const api = createApp(db);

    const body = await (await api.request('/api/board/cpm')).json();

    expect(body.projectDuration).toBe(60);
    expect(node(body, aId)).toMatchObject({ durationMinutes: null, earliestFinish: 0 });
  });

  it('只算当前这一层：子任务的依赖不出现在父层图里', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父任务', columnId: 'todo', orders: 1000 });
    const xId = insertTask(db, { title: 'X', columnId: 'todo', orders: 1000, parentId, durationMinutes: 10 });
    const yId = insertTask(db, { title: 'Y', columnId: 'doing', orders: 1000, parentId, durationMinutes: 20 });
    addDep(db, xId, yId);
    const api = createApp(db);

    const root = await (await api.request('/api/board/cpm')).json();
    expect(root.nodes.map((item: { id: string }) => item.id)).toEqual([parentId]);
    expect(root.edges).toEqual([]);

    const layer = await (await api.request(`/api/board/${parentId}/cpm`)).json();
    expect(layer.parentId).toBe(parentId);
    expect(layer.projectDuration).toBe(30);
    expect(layer.nodes.map((item: { id: string }) => item.id)).toEqual([xId, yId]);
    expect(layer.edges).toEqual([{ predecessorId: xId, successorId: yId, critical: true }]);
  });

  it('归档任务与连着它的边默认不出现，includeArchived=1 时出现', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000, durationMinutes: 10 });
    const bId = insertTask(db, {
      title: 'B',
      columnId: 'todo',
      orders: 2000,
      durationMinutes: 20,
      archived: true,
    });
    addDep(db, aId, bId);
    const api = createApp(db);

    const visible = await (await api.request('/api/board/cpm')).json();
    expect(visible.nodes.map((item: { id: string }) => item.id)).toEqual([aId]);
    expect(visible.edges).toEqual([]);
    expect(visible.projectDuration).toBe(10);

    const full = await (await api.request('/api/board/cpm?includeArchived=1')).json();
    expect(full.nodes.map((item: { id: string }) => item.id)).toEqual([aId, bId]);
    expect(full.edges).toEqual([{ predecessorId: aId, successorId: bId, critical: true }]);
    expect(node(full, bId).archivedAt).not.toBeNull();
  });

  it('跨层的脏边被忽略，而不是给出一条端点不存在的边', async () => {
    const db = createTestDb();
    const rootId = insertTask(db, { title: '根任务', columnId: 'todo', orders: 1000, durationMinutes: 10 });
    const parentId = insertTask(db, { title: '父任务', columnId: 'todo', orders: 2000 });
    const childId = insertTask(db, { title: '子任务', columnId: 'todo', orders: 1000, parentId });
    // 接口不可能写出跨层依赖，手工改库可以。
    addDep(db, childId, rootId);
    const api = createApp(db);

    const root = await (await api.request('/api/board/cpm')).json();

    expect(root.nodes.map((item: { id: string }) => item.id)).toEqual([rootId, parentId]);
    expect(root.edges).toEqual([]);
  });

  it('空看板返回空图与 0 工期', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '没有子任务的父任务', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    // 根层只有一个没有依赖的任务：图里只有它自己，没有边。
    const root = await (await api.request('/api/board/cpm')).json();
    expect(root.parentId).toBeNull();
    expect(root.nodes.map((item: { id: string }) => item.id)).toEqual([parentId]);
    expect(root.edges).toEqual([]);
    expect(root.projectDuration).toBe(0);

    // 它自己的看板里一个任务都没有。
    const layer = await (await api.request(`/api/board/${parentId}/cpm`)).json();
    expect(layer).toEqual({ parentId, projectDuration: 0, nodes: [], edges: [] });
  });

  it('任务不存在返回 404', async () => {
    const api = createApp(createTestDb());

    const response = await api.request('/api/board/不存在的任务/cpm');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '任务不存在' });
  });

  it('依赖图成环的脏数据返回 500 并记日志，不返回一张假图', async () => {
    const db = createTestDb();
    const aId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const bId = insertTask(db, { title: 'B', columnId: 'todo', orders: 2000 });
    addDep(db, aId, bId);
    addDep(db, bId, aId);
    const api = createApp(db);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await api.request('/api/board/cpm');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '服务器内部错误' });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it('/api/board/cpm 不会被 /api/board/:parentId 抢走，子看板照常返回', async () => {
    const db = createTestDb();
    const taskId = insertTask(db, { title: 'A', columnId: 'todo', orders: 1000 });
    const api = createApp(db);

    const cpm = await (await api.request('/api/board/cpm')).json();
    expect(cpm).toHaveProperty('nodes');
    expect(cpm).not.toHaveProperty('columns');

    // 根看板照常，任务看板也照常（taskId 没有子任务，所以是三列空）。
    const root = await (await api.request('/api/board')).json();
    expect(root.columns.flatMap((column: { tasks: unknown[] }) => column.tasks)).toHaveLength(1);
    const childBoard = await (await api.request(`/api/board/${taskId}`)).json();
    expect(childBoard.parentId).toBe(taskId);
    expect(childBoard.columns.every((column: { tasks: unknown[] }) => column.tasks.length === 0)).toBe(
      true,
    );
  });
});
