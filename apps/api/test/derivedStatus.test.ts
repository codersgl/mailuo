import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { reconcileDerivedStatus } from '../src/repositories/tasks.js';
import {
  createTestDb,
  insertTask,
  readJson,
  type BoardBody,
  type ErrorBody,
  type TaskBody,
  type TaskMutationBody,
} from './helpers.js';

type App = ReturnType<typeof createApp>;

function jsonRequest(app: App, method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 某种状态下任务在库里的列。断言真实落库结果，而不是只看接口返回的那一份。 */
function columnOf(db: Db, id: string): string {
  return (db.prepare('SELECT column_id FROM tasks WHERE id = ?').get(id) as { column_id: string })
    .column_id;
}

/** 计时的两列，用来断言父任务真的没有在走表。 */
function clockOf(db: Db, id: string): { spent_minutes: number; running_since: string | null } {
  return db.prepare('SELECT spent_minutes, running_since FROM tasks WHERE id = ?').get(id) as {
    spent_minutes: number;
    running_since: string | null;
  };
}

/** 库里存的工期（分钟）；null 表示未估。 */
function durationOf(db: Db, id: string): number | null {
  return (
    db.prepare('SELECT duration_minutes FROM tasks WHERE id = ?').get(id) as {
      duration_minutes: number | null;
    }
  ).duration_minutes;
}

/** 把「正在计时的这一段」改成 minutes 分钟前开始，让结算结果可预期。 */
function startSegmentAgo(db: Db, id: string, minutes: number): void {
  db.prepare('UPDATE tasks SET running_since = ? WHERE id = ?').run(
    new Date(Date.now() - minutes * 60_000).toISOString(),
    id,
  );
}

/** 某一层某一列的任务标题，按 orders（看谁排在哪）。 */
async function columnTitles(
  app: App,
  parentId: string | null,
  columnId: string,
): Promise<string[]> {
  const path = parentId === null ? '/api/board' : `/api/board/${parentId}`;
  const board = await readJson<BoardBody>(await app.request(path));
  return (board.columns.find((column) => column.id === columnId)?.tasks ?? []).map(
    (task) => task.title,
  );
}

describe('状态推导：父任务的列由子任务决定', () => {
  it('子任务进入进行中，整条祖先链跟着进行中；拖回来又一起回到待办', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const project = insertTask(db, { title: '项目', columnId: 'todo', orders: 1000 });
    const sub = insertTask(db, {
      title: '重构登录',
      columnId: 'todo',
      orders: 1000,
      parentId: project,
    });
    const leaf = insertTask(db, { title: '前端部分', columnId: 'todo', orders: 1000, parentId: sub });

    await jsonRequest(api, 'PATCH', `/api/tasks/${leaf}`, { columnId: 'doing', position: 0 });

    expect(columnOf(db, leaf)).toBe('doing');
    expect(columnOf(db, sub)).toBe('doing');
    expect(columnOf(db, project)).toBe('doing');

    // 往回拖：没有任何子任务在进行中，也没有全部完成，于是整条链回到待办。
    // 这一条是「完全推导」与「只加两条单向规则」的分界：后者会把父任务留在进行中。
    await jsonRequest(api, 'PATCH', `/api/tasks/${leaf}`, { columnId: 'todo', position: 0 });

    expect(columnOf(db, leaf)).toBe('todo');
    expect(columnOf(db, sub)).toBe('todo');
    expect(columnOf(db, project)).toBe('todo');
  });

  it('子任务全部完成时父任务与祖先一起进入完成列', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const project = insertTask(db, { title: '项目', columnId: 'todo', orders: 1000 });
    const sub = insertTask(db, { title: '子', columnId: 'todo', orders: 1000, parentId: project });
    const leaf = insertTask(db, { title: '孙', columnId: 'todo', orders: 1000, parentId: sub });

    await jsonRequest(api, 'PATCH', `/api/tasks/${leaf}`, { columnId: 'done', position: 0 });

    expect(columnOf(db, leaf)).toBe('done');
    expect(columnOf(db, sub)).toBe('done');
    expect(columnOf(db, project)).toBe('done');
  });

  it('一个兄弟还在干就压过「全部完成」：父任务不能显示完成', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = insertTask(db, { title: '父', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '做完了', columnId: 'done', orders: 1000, parentId: parent });
    const doing = insertTask(db, { title: '还在干', columnId: 'todo', orders: 2000, parentId: parent });

    await jsonRequest(api, 'PATCH', `/api/tasks/${doing}`, { columnId: 'doing', position: 0 });

    expect(columnOf(db, parent)).toBe('doing');
  });

  it('新建子任务就把父任务的列重新推一遍', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = await readJson<TaskBody>(
      await jsonRequest(api, 'POST', '/api/tasks', { parentId: null, columnId: 'todo', title: '父' }),
    );

    await jsonRequest(api, 'POST', '/api/tasks', {
      parentId: parent.id,
      columnId: 'done',
      title: '唯一的子任务，已完成',
    });

    expect(columnOf(db, parent.id)).toBe('done');
  });

  it('取消归档后，父任务的列按恢复出来的子任务重算', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = insertTask(db, { title: '父', columnId: 'todo', orders: 1000 });
    const child = insertTask(db, {
      title: '在干的子任务',
      columnId: 'doing',
      orders: 1000,
      parentId: parent,
    });

    await jsonRequest(api, 'PATCH', `/api/tasks/${parent}/archive`, { archived: true });
    await jsonRequest(api, 'PATCH', `/api/tasks/${parent}/archive`, { archived: false });

    expect(columnOf(db, child)).toBe('doing');
    expect(columnOf(db, parent)).toBe('doing');
  });
});

describe('状态推导：手动移动的边界', () => {
  it('有子任务的父任务不能手动换列：返回 400 并说明原因', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = insertTask(db, { title: '父', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '子', columnId: 'todo', orders: 1000, parentId: parent });

    const response = await jsonRequest(api, 'PATCH', `/api/tasks/${parent}`, {
      columnId: 'doing',
      position: 0,
    });

    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error).toContain('子任务');
    expect(columnOf(db, parent)).toBe('todo');
  });

  it('同列内重排也拒绝：父任务的列与列内位置都不由用户定', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = insertTask(db, { title: '父', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '子', columnId: 'todo', orders: 1000, parentId: parent });
    const other = insertTask(db, { title: '别的根任务', columnId: 'todo', orders: 2000 });

    const response = await jsonRequest(api, 'PATCH', `/api/tasks/${parent}`, {
      columnId: 'todo',
      position: 1,
    });

    expect(response.status).toBe(400);
    // 拒绝之后这一列一个字都没动。
    expect(await columnTitles(api, null, 'todo')).toEqual(['父', '别的根任务']);
    expect(columnOf(db, other)).toBe('todo');
  });

  it('有子任务的父任务不能单独设工期：返回 400，库里那个值原样不动', async () => {
    // 父任务的工期是子树叶子的汇总（D78），写进去没有任何地方会读它，所以在入口就拒掉。
    const db = createTestDb();
    const api = createApp(db);
    const parent = insertTask(db, {
      title: '父',
      columnId: 'todo',
      orders: 1000,
      durationMinutes: 120,
    });
    insertTask(db, { title: '子', columnId: 'todo', orders: 1000, parentId: parent, durationMinutes: 60 });

    const response = await jsonRequest(api, 'PATCH', `/api/tasks/${parent}`, {
      durationMinutes: 999,
    });

    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error).toContain('汇总');
    expect(durationOf(db, parent)).toBe(120);
  });

  it('把父任务的工期清回未估也拒绝：不能借这一步绕过那条限制', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = insertTask(db, {
      title: '父',
      columnId: 'todo',
      orders: 1000,
      durationMinutes: 120,
    });
    insertTask(db, { title: '子', columnId: 'todo', orders: 1000, parentId: parent });

    const response = await jsonRequest(api, 'PATCH', `/api/tasks/${parent}`, {
      durationMinutes: null,
    });

    expect(response.status).toBe(400);
    expect(durationOf(db, parent)).toBe(120);
  });

  it('叶子照旧可以设工期，也可以清回未估', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const leaf = insertTask(db, { title: '叶子', columnId: 'todo', orders: 1000 });

    const set = await jsonRequest(api, 'PATCH', `/api/tasks/${leaf}`, { durationMinutes: 90 });
    expect(set.status).toBe(200);
    expect(durationOf(db, leaf)).toBe(90);

    const cleared = await jsonRequest(api, 'PATCH', `/api/tasks/${leaf}`, { durationMinutes: null });
    expect(cleared.status).toBe(200);
    expect(durationOf(db, leaf)).toBeNull();
  });

  it('改别的字段不受影响：父任务照旧能改标题', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = insertTask(db, { title: '父', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '子', columnId: 'todo', orders: 1000, parentId: parent });

    const response = await jsonRequest(api, 'PATCH', `/api/tasks/${parent}`, { title: '父改名' });

    expect(response.status).toBe(200);
    expect((await readJson<TaskMutationBody>(response)).task.title).toBe('父改名');
  });

  it('叶子任务照旧可以手动换列', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const leaf = insertTask(db, { title: '叶子', columnId: 'todo', orders: 1000 });

    const response = await jsonRequest(api, 'PATCH', `/api/tasks/${leaf}`, {
      columnId: 'doing',
      position: 0,
    });

    expect(response.status).toBe(200);
    expect(columnOf(db, leaf)).toBe('doing');
  });

  it('把有子任务的任务挂到新父级下：列不变时允许，顺带换列时拒绝', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const oldParent = insertTask(db, { title: '老父', columnId: 'todo', orders: 1000 });
    const newParent = insertTask(db, { title: '新父', columnId: 'todo', orders: 2000 });
    const mid = insertTask(db, { title: '中间层', columnId: 'todo', orders: 1000, parentId: oldParent });
    insertTask(db, { title: '孙', columnId: 'todo', orders: 1000, parentId: mid });

    const rejected = await jsonRequest(api, 'PATCH', `/api/tasks/${mid}/parent`, {
      parentId: newParent,
      columnId: 'doing',
    });
    expect(rejected.status).toBe(400);
    expect((await readJson<ErrorBody>(rejected)).error).toContain('子任务');

    // 任务树拖动发过来的就是它当前的列，所以正常路径走的是这一条。
    const accepted = await jsonRequest(api, 'PATCH', `/api/tasks/${mid}/parent`, {
      parentId: newParent,
      columnId: 'todo',
    });
    expect(accepted.status).toBe(200);
    expect(columnOf(db, mid)).toBe('todo');
  });
});

describe('状态推导：父任务不计时', () => {
  it('给正在计时的任务加一个子任务：父任务停表并结算，子任务自己照常跑', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = await readJson<TaskBody>(
      await jsonRequest(api, 'POST', '/api/tasks', {
        parentId: null,
        columnId: 'doing',
        title: '父',
      }),
    );
    startSegmentAgo(db, parent.id, 30);

    const child = await readJson<TaskBody>(
      await jsonRequest(api, 'POST', '/api/tasks', {
        parentId: parent.id,
        columnId: 'doing',
        title: '子',
      }),
    );

    // 父任务被推导成待办？不：子任务在进行中，所以父任务留在进行中——但它的表是停的。
    expect(columnOf(db, parent.id)).toBe('doing');
    expect(clockOf(db, parent.id)).toEqual({ spent_minutes: 30, running_since: null });

    // 子任务是叶子，建在进行中就从那一刻开始计时。
    const childClock = clockOf(db, child.id);
    expect(childClock.spent_minutes).toBe(0);
    expect(childClock.running_since).not.toBeNull();
  });

  it('删掉最后一个子任务后父任务变回叶子，在进行中就重新开始计时', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = await readJson<TaskBody>(
      await jsonRequest(api, 'POST', '/api/tasks', {
        parentId: null,
        columnId: 'doing',
        title: '父',
      }),
    );
    const child = await readJson<TaskBody>(
      await jsonRequest(api, 'POST', '/api/tasks', {
        parentId: parent.id,
        columnId: 'doing',
        title: '子',
      }),
    );
    expect(clockOf(db, parent.id).running_since).toBeNull();

    await jsonRequest(api, 'DELETE', `/api/tasks/${child.id}`);

    expect(columnOf(db, parent.id)).toBe('doing');
    expect(clockOf(db, parent.id).running_since).not.toBeNull();
  });

  it('归档最后一个子任务后父任务变回叶子，在进行中就重新开始计时', async () => {
    const db = createTestDb();
    const api = createApp(db);
    const parent = await readJson<TaskBody>(
      await jsonRequest(api, 'POST', '/api/tasks', {
        parentId: null,
        columnId: 'doing',
        title: '父',
      }),
    );
    const child = await readJson<TaskBody>(
      await jsonRequest(api, 'POST', '/api/tasks', {
        parentId: parent.id,
        columnId: 'doing',
        title: '子',
      }),
    );
    expect(clockOf(db, parent.id).running_since).toBeNull();

    await jsonRequest(api, 'PATCH', `/api/tasks/${child.id}/archive`, { archived: true });

    expect(columnOf(db, parent.id)).toBe('doing');
    expect(clockOf(db, parent.id).running_since).not.toBeNull();
  });
});

describe('reconcileDerivedStatus', () => {
  it('同一批多个父任务被推导进同一列时，orders 依次往后排且不撞值', async () => {
    const db = createTestDb();
    const api = createApp(db);
    // 三个根层父任务，各自有一个在干的子任务；它们会在同一次对账里一起被推导进根层的「进行中」。
    const parents = ['甲', '乙', '丙'].map((title, index) => {
      const parent = insertTask(db, { title, columnId: 'todo', orders: (index + 1) * 1000 });
      insertTask(db, { title: `${title}的子`, columnId: 'doing', orders: 1000, parentId: parent });
      return parent;
    });
    // 随便触发一次写入口的对账（改标题也算，它会走到 reconcileDerivedStatus）。
    await jsonRequest(api, 'PATCH', `/api/tasks/${parents[0]}`, { title: '甲 v2' });

    const doing = (await readJson<BoardBody>(await api.request('/api/board'))).columns.find(
      (column) => column.id === 'doing',
    )!;
    const orders = doing.tasks.map((task) => task.orders);

    // 断言「都在这一列、号互不相同」而不是「谁拿 1000」：同一批的先后由扫描顺序决定，
    // 那条 SELECT 没有 ORDER BY，钉死具体映射就是把实现巧合当契约（审阅指出过这一点）。
    expect([...doing.tasks.map((task) => task.title)].sort()).toEqual(['丙', '乙', '甲 v2'].sort());
    expect([...orders].sort((left, right) => left - right)).toEqual([1000, 2000, 3000]);
    // 撞值会让同一列里的先后变得不可预期（后端排序只按 orders），所以这条必须钉住。
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('父子成环的脏数据不会让对账每次都写一遍', () => {
    const db = createTestDb();
    const a = insertTask(db, { title: '甲', columnId: 'done', orders: 1000 });
    const b = insertTask(db, { title: '乙', columnId: 'todo', orders: 1000 });
    // 先建成两个根任务再互相挂：外键打开时没法先插一条指向尚不存在的父任务的行。
    db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(b, a);
    db.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?').run(a, b);

    const snapshot = () =>
      db.prepare('SELECT id, column_id, updated_at FROM tasks ORDER BY id').all();

    reconcileDerivedStatus(db, '2026-01-01T00:00:00.000Z');
    const first = snapshot();
    reconcileDerivedStatus(db, '2026-06-01T00:00:00.000Z');

    // 环上的任务保留各自的列，所以第二次对账一个字节都不写——「状态一致时不写行」在脏数据上也要成立，
    // 否则一个成环的库会在每次写请求里刷新这几行的 updated_at。
    expect(snapshot()).toEqual(first);
  });

  it('状态一致时一个字节都不写：updated_at 不动', async () => {
    const db = createTestDb();
    const parent = insertTask(db, { title: '父', columnId: 'todo', orders: 1000 });
    insertTask(db, { title: '子', columnId: 'done', orders: 1000, parentId: parent });

    reconcileDerivedStatus(db, '2026-01-01T00:00:00.000Z');
    expect(columnOf(db, parent)).toBe('done');
    const first = db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(parent) as {
      updated_at: string;
    };

    reconcileDerivedStatus(db, '2026-06-01T00:00:00.000Z');

    const second = db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(parent) as {
      updated_at: string;
    };
    expect(second.updated_at).toBe(first.updated_at);
  });
});
