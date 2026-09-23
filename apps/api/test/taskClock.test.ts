import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import {
  createTestDb,
  insertTask,
  readJson,
  type BoardBody,
  type SearchBody,
  type TaskBody,
  type TaskMutationBody,
  type TreeBody,
} from './helpers.js';

type App = ReturnType<typeof createApp>;

function jsonRequest(app: App, method: 'POST' | 'PATCH', path: string, body: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 把「正在计时的这一段」改成 minutes 分钟前开始，让结算结果可预期。 */
function startSegmentAgo(db: Db, id: string, minutes: number): void {
  db.prepare('UPDATE tasks SET running_since = ? WHERE id = ?').run(
    new Date(Date.now() - minutes * 60_000).toISOString(),
    id,
  );
}

/** 单个任务的计时两列，用来断言 DB 里的真实状态而不只看响应。 */
function clockOf(db: Db, id: string): { spent_minutes: number; running_since: string | null } {
  return db.prepare('SELECT spent_minutes, running_since FROM tasks WHERE id = ?').get(id) as {
    spent_minutes: number;
    running_since: string | null;
  };
}

/**
 * 违反不变式（running_since 非空 ⟺ 进行中且未归档）的任务 id。
 *
 * 每个用例都查一次，而不是逐条断言调用点：会改到列或归档状态的写入口有好几处
 * （新建、移动、改父级、归档、取消归档），漏掉任何一个都会留下「永远不计时的任务」
 * 或者「停不下来的表」，而这两种毛病都不会让别的断言变红。
 */
function clockViolations(db: Db): Array<{ id: string }> {
  return db
    .prepare(
      `SELECT id FROM tasks
        WHERE (running_since IS NOT NULL) <> (column_id = 'doing' AND archived_at IS NULL)`,
    )
    .all() as Array<{ id: string }>;
}

describe('工期计时的写入口', () => {
  it('新建在「进行中」的任务从建立那一刻开始计时', async () => {
    const db = createTestDb();
    const response = await jsonRequest(createApp(db), 'POST', '/api/tasks', {
      parentId: null,
      columnId: 'doing',
      title: '直接开工',
    });

    expect(response.status).toBe(201);
    const task = await readJson<TaskBody>(response);
    expect(task.spentMinutes).toBe(0);
    expect(typeof task.runningSince).toBe('string');
    expect(clockViolations(db)).toEqual([]);
  });

  it('新建在待办的任务不计时', async () => {
    const db = createTestDb();
    const response = await jsonRequest(createApp(db), 'POST', '/api/tasks', {
      parentId: null,
      columnId: 'todo',
      title: '先记下来',
    });

    const task = await readJson<TaskBody>(response);
    expect(task.spentMinutes).toBe(0);
    expect(task.runningSince).toBeNull();
    expect(clockViolations(db)).toEqual([]);
  });

  it('把任务拖出「进行中」时结算这一段用时', async () => {
    const db = createTestDb();
    const id = insertTask(db, {
      title: '做着做着停了',
      columnId: 'doing',
      orders: 1000,
      runningSince: new Date().toISOString(),
    });
    startSegmentAgo(db, id, 61);

    const response = await jsonRequest(createApp(db), 'PATCH', `/api/tasks/${id}`, {
      columnId: 'todo',
      position: 0,
    });

    expect(response.status).toBe(200);
    const { task } = await readJson<TaskMutationBody>(response);
    expect(task.spentMinutes).toBe(61);
    expect(task.runningSince).toBeNull();
    expect(clockViolations(db)).toEqual([]);
  });

  it('拖到「完成」列同样停表', async () => {
    const db = createTestDb();
    const id = insertTask(db, {
      title: '做完了',
      columnId: 'doing',
      orders: 1000,
      runningSince: new Date().toISOString(),
    });
    startSegmentAgo(db, id, 10);

    const { task } = await readJson<TaskMutationBody>(
      await jsonRequest(createApp(db), 'PATCH', `/api/tasks/${id}`, { columnId: 'done', position: 0 }),
    );

    expect(task.spentMinutes).toBe(10);
    expect(task.runningSince).toBeNull();
    expect(clockViolations(db)).toEqual([]);
  });

  it('回到待办再开工，已用继续累计而不是从零开始', async () => {
    const db = createTestDb();
    const id = insertTask(db, { title: '分段做', columnId: 'todo', orders: 1000, spentMinutes: 30 });
    const api = createApp(db);

    await jsonRequest(api, 'PATCH', `/api/tasks/${id}`, { columnId: 'doing', position: 0 });
    startSegmentAgo(db, id, 40);
    const response = await jsonRequest(api, 'PATCH', `/api/tasks/${id}`, { columnId: 'todo', position: 0 });

    const { task } = await readJson<TaskMutationBody>(response);
    expect(task.spentMinutes).toBe(70);
    expect(task.runningSince).toBeNull();
    expect(clockViolations(db)).toEqual([]);
  });

  it('同一列内重排不会碰到计时：任务从没离开「进行中」', async () => {
    const db = createTestDb();
    const runningSince = new Date().toISOString();
    const moved = insertTask(db, { title: '在跑', columnId: 'doing', orders: 1000, runningSince });
    // 同列的另一张也要满足不变式（进行中且未归档 ⟺ 正在计时），否则用例末尾的全库断言会
    // 把夹具自己的问题报成实现的问题。
    insertTask(db, {
      title: '同列的另一张',
      columnId: 'doing',
      orders: 2000,
      runningSince: new Date().toISOString(),
    });

    const { task } = await readJson<TaskMutationBody>(
      await jsonRequest(createApp(db), 'PATCH', `/api/tasks/${moved}`, {
        columnId: 'doing',
        position: 1,
      }),
    );

    // 逐字不变：既没有把当前这一段吞进 spent_minutes，也没有把开始时刻重置成「现在」。
    // 这是个很容易写错的边界——moveTask 里若按「旧列停表 + 新列开表」结算，同列重排一次
    // 就会结算一次，任务明明没离开这一列，已用却涨了，还会每次丢掉不足一分钟的零头。
    expect(task.runningSince).toBe(runningSince);
    expect(task.spentMinutes).toBe(0);
    expect(clockViolations(db)).toEqual([]);
  });

  it('只改标题不会中断正在进行的计时', async () => {
    const db = createTestDb();
    const runningSince = '2024-01-01T00:00:00.000Z';
    const id = insertTask(db, { title: '旧标题', columnId: 'doing', orders: 1000, runningSince });

    const { task } = await readJson<TaskMutationBody>(
      await jsonRequest(createApp(db), 'PATCH', `/api/tasks/${id}`, { title: '新标题' }),
    );

    expect(task.title).toBe('新标题');
    expect(task.runningSince).toBe(runningSince);
    expect(task.spentMinutes).toBe(0);
  });

  it('改父级但仍在「进行中」时计时不中断', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '新父', columnId: 'todo', orders: 1000 });
    const runningSince = '2024-01-01T00:00:00.000Z';
    const id = insertTask(db, { title: '换个父级', columnId: 'doing', orders: 1000, runningSince });

    const { task } = await readJson<TaskMutationBody>(
      await jsonRequest(createApp(db), 'PATCH', `/api/tasks/${id}/parent`, { parentId, columnId: 'doing' }),
    );

    expect(task.parentId).toBe(parentId);
    expect(task.runningSince).toBe(runningSince);
    expect(task.spentMinutes).toBe(0);
  });

  it('改父级同时换出「进行中」会结算', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '新父', columnId: 'todo', orders: 1000 });
    const id = insertTask(db, {
      title: '被拖到别处',
      columnId: 'doing',
      orders: 1000,
      runningSince: new Date().toISOString(),
    });
    startSegmentAgo(db, id, 5);

    const { task } = await readJson<TaskMutationBody>(
      await jsonRequest(createApp(db), 'PATCH', `/api/tasks/${id}/parent`, { parentId, columnId: 'todo' }),
    );

    expect(task.spentMinutes).toBe(5);
    expect(task.runningSince).toBeNull();
    expect(clockViolations(db)).toEqual([]);
  });

  it('归档停表，取消归档后处于「进行中」的任务重新开始计时', async () => {
    const db = createTestDb();
    const id = insertTask(db, {
      title: '归档再恢复',
      columnId: 'doing',
      orders: 1000,
      runningSince: new Date().toISOString(),
    });
    startSegmentAgo(db, id, 61);
    const api = createApp(db);

    const archived = await readJson<TaskMutationBody>(
      await jsonRequest(api, 'PATCH', `/api/tasks/${id}/archive`, { archived: true }),
    );
    expect(archived.task.spentMinutes).toBe(61);
    expect(archived.task.runningSince).toBeNull();
    expect(clockViolations(db)).toEqual([]);

    const restored = await readJson<TaskMutationBody>(
      await jsonRequest(api, 'PATCH', `/api/tasks/${id}/archive`, { archived: false }),
    );
    // 已用不因为归档往返而清零，重新计时从恢复那一刻算起。
    expect(restored.task.spentMinutes).toBe(61);
    expect(typeof restored.task.runningSince).toBe('string');
    expect(clockViolations(db)).toEqual([]);
  });

  it('归档一棵子树会把子树里正在计时的任务都停下来', async () => {
    const db = createTestDb();
    const parentId = insertTask(db, { title: '父', columnId: 'todo', orders: 1000 });
    const childId = insertTask(db, {
      title: '子在跑',
      columnId: 'doing',
      orders: 1000,
      parentId,
      runningSince: new Date().toISOString(),
    });
    startSegmentAgo(db, childId, 30);

    await jsonRequest(createApp(db), 'PATCH', `/api/tasks/${parentId}/archive`, { archived: true });

    const child = clockOf(db, childId);
    expect(child.spent_minutes).toBe(30);
    expect(child.running_since).toBeNull();
    expect(clockViolations(db)).toEqual([]);
  });
});

describe('工期计时字段的读出口', () => {
  it('看板与任务树都带上工期、已用与这一段的开始时刻', async () => {
    const db = createTestDb();
    const runningSince = '2024-01-01T00:00:00.000Z';
    const id = insertTask(db, {
      title: '在跑的任务',
      columnId: 'doing',
      orders: 1000,
      durationMinutes: 480,
      spentMinutes: 120,
      runningSince,
    });
    const api = createApp(db);

    const board = await readJson<BoardBody>(await api.request('/api/board'));
    const doing = board.columns.find((column: { id: string }) => column.id === 'doing')!;
    expect(doing.tasks[0]).toMatchObject({
      id,
      durationMinutes: 480,
      spentMinutes: 120,
      runningSince,
    });

    const tree = await readJson<TreeBody>(await api.request('/api/tree'));
    expect(tree.tasks[0]).toMatchObject({
      id,
      durationMinutes: 480,
      spentMinutes: 120,
      runningSince,
    });
  });

  it('搜索结果的字段集不受影响（提醒标记只出现在看板与任务树）', async () => {
    const db = createTestDb();
    insertTask(db, { title: '关键词', columnId: 'doing', orders: 1000, durationMinutes: 60 });

    const { results } = await readJson<SearchBody>(await createApp(db).request('/api/search?q=关键词'));

    expect(results[0]).not.toHaveProperty('spentMinutes');
    expect(results[0]).not.toHaveProperty('runningSince');
  });
});
