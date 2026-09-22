import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { Board, BoardTask, TreeTask } from '../src/api/types';

/**
 * 端到端过一遍：URL → 哪一层看板 → 面包屑与文件树选中态 → 点卡片进下一层，
 * 以及本步新增的增删改链路（新建、保存、归档、删除，写后整页静默重取）。
 *
 * 这里放了一个最小的假后端：任务放在内存数组里，写接口真的改它，读接口从它算。
 * 只打桩返回固定 JSON 的话，「写完之后页面是不是真的刷新了」这条最关键的行为测不出来。
 * 真实后端的契约（排序、环检测、级联删除等）由 apps/api 的用例保证。
 */

interface FakeTask {
  id: string;
  parentId: string | null;
  columnId: string;
  title: string;
  description: string;
  durationMinutes: number | null;
  orders: number;
  archivedAt: string | null;
}

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

function task(overrides: Partial<FakeTask> & Pick<FakeTask, 'id' | 'title'>): FakeTask {
  return {
    parentId: null,
    columnId: 'todo',
    description: '',
    durationMinutes: null,
    orders: 1000,
    archivedAt: null,
    ...overrides,
  };
}

function createFakeApi(initial: FakeTask[], options: { postError?: string } = {}) {
  const tasks = initial.map((item) => ({ ...item }));
  const calls: RecordedCall[] = [];
  let sequence = 0;
  /**
   * 「静默重取」是否要挂起看板读请求。写完之后把看板 GET 卡住，才能观察到这段窗口里界面
   * 长什么样（旧卡片还在、没有「加载中」）。返回放行函数。
   */
  let holdingBoardReads = false;
  const boardWaiters: Array<() => void> = [];
  function holdBoardReads(): () => void {
    holdingBoardReads = true;
    return () => {
      holdingBoardReads = false;
      for (const release of boardWaiters.splice(0)) release();
    };
  }

  function visible(includeArchived: boolean): FakeTask[] {
    return tasks.filter((item) => includeArchived || item.archivedAt === null);
  }

  /** 卡片形状：任务字段 + 直接子任务进度（分母只数未归档的子任务）。 */
  function toBoardTask(item: FakeTask): BoardTask {
    const children = tasks.filter((child) => child.parentId === item.id && child.archivedAt === null);
    return {
      ...item,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
      childTotal: children.length,
      childDone: children.filter((child) => child.columnId === 'done').length,
    };
  }

  function boardFor(parentId: string | null, includeArchived: boolean): Board {
    const columns = [
      { id: 'todo', name: '待办', orders: 1000 },
      { id: 'doing', name: '进行中', orders: 2000 },
      { id: 'done', name: '完成', orders: 3000 },
    ];
    return {
      parentId,
      columns: columns.map((column) => ({
        ...column,
        tasks: visible(includeArchived)
          .filter((item) => item.parentId === parentId && item.columnId === column.id)
          .sort((a, b) => a.orders - b.orders)
          .map(toBoardTask),
      })),
    };
  }

  function tree(includeArchived: boolean): TreeTask[] {
    return visible(includeArchived).map((item) => ({
      id: item.id,
      parentId: item.parentId,
      title: item.title,
      columnId: item.columnId,
      archivedAt: item.archivedAt,
    }));
  }

  function breadcrumb(taskId: string) {
    const chain: Array<{ id: string | null; title: string }> = [];
    let current = tasks.find((item) => item.id === taskId);
    while (current) {
      chain.unshift({ id: current.id, title: current.title });
      current = current.parentId === null ? undefined : tasks.find((item) => item.id === current!.parentId);
    }
    return [{ id: null, title: '根看板' }, ...chain];
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body: Record<string, unknown> =
      init?.body === undefined ? {} : JSON.parse(String(init.body));
    calls.push({ method, url, body });

    const [path = '', query = ''] = url.split('?');
    const includeArchived = query.includes('includeArchived');
    const id = (prefix: string) => decodeURIComponent(path.slice(prefix.length));

    /** 看板读请求；holdBoardReads 打开时先挂起，由放行函数决定什么时候返回。 */
    const readBoard = (parentId: string | null) => {
      const payload = boardFor(parentId, includeArchived);
      if (!holdingBoardReads) return json(payload);
      return new Promise<Response>((resolve) => boardWaiters.push(() => resolve(json(payload))));
    };

    if (method === 'GET' && path === '/api/board') return readBoard(null);
    if (method === 'GET' && path === '/api/tree') return json({ tasks: tree(includeArchived) });
    if (method === 'GET' && path.startsWith('/api/board/')) {
      const parentId = id('/api/board/');
      // 与真后端一致：看板接口对不存在的父任务回 404（仓储只查询，存在性由路由判）。
      if (!tasks.some((item) => item.id === parentId)) return json({ error: '任务不存在' }, 404);
      return readBoard(parentId);
    }
    if (method === 'GET' && path.startsWith('/api/breadcrumb/')) {
      const taskId = id('/api/breadcrumb/');
      if (!tasks.some((item) => item.id === taskId)) return json({ error: '任务不存在' }, 404);
      return json({ items: breadcrumb(taskId) });
    }

    if (method === 'POST' && path === '/api/tasks') {
      if (options.postError !== undefined) return json({ error: options.postError }, 400);
      sequence += 1;
      const created: FakeTask = {
        id: `new-${sequence}`,
        parentId: (body.parentId as string | null) ?? null,
        columnId: body.columnId as string,
        // 真后端的标题 schema 会 trim（见 apps/api/src/schemas/task.ts），这里跟上。
        title: (body.title as string).trim(),
        description: '',
        durationMinutes: null,
        orders: 1000 + sequence,
        archivedAt: null,
      };
      tasks.push(created);
      return json(toBoardTask(created), 201);
    }

    if (method === 'PATCH' && path.endsWith('/archive')) {
      const item = tasks.find((candidate) => candidate.id === id('/api/tasks/').replace(/\/archive$/, ''));
      if (!item) return json({ error: '任务不存在' }, 404);
      // 真实后端归档的是整棵子树；这里的用例没有子任务，只改自己。
      item.archivedAt = body.archived === true ? '2026-09-22T02:00:00.000Z' : null;
      return json({ task: toBoardTask(item), columnTasks: [] });
    }

    if (method === 'PATCH' && path.startsWith('/api/tasks/')) {
      const item = tasks.find((candidate) => candidate.id === id('/api/tasks/'));
      if (!item) return json({ error: '任务不存在' }, 404);
      if (typeof body.title === 'string') item.title = body.title.trim();
      if (typeof body.description === 'string') item.description = body.description;
      if ('durationMinutes' in body) item.durationMinutes = body.durationMinutes as number | null;
      return json({ task: toBoardTask(item), columnTasks: [] });
    }

    if (method === 'DELETE' && path.startsWith('/api/tasks/')) {
      const target = id('/api/tasks/');
      for (let index = tasks.length - 1; index >= 0; index -= 1) {
        if (tasks[index]?.id === target) tasks.splice(index, 1);
      }
      return json({ columnTasks: [] });
    }

    return json({ error: '任务不存在' }, 404);
  });

  return { calls, tasks, holdBoardReads };
}

const fixtures: FakeTask[] = [
  task({ id: 'b', title: '支付对账' }),
  task({ id: 'b1', title: '对账脚本', parentId: 'b' }),
  task({ id: 'a', title: '重构登录', columnId: 'doing', orders: 2000 }),
  task({ id: 'z', title: '旧版导出', archivedAt: '2026-09-22T00:00:00.000Z' }),
];

/** 看板区是 main；文件树在 aside 里，同名任务（面包屑、树、卡片、抽屉）用 within 区分。 */
function boardArea() {
  return within(document.querySelector('main')!);
}

function breadcrumbNav() {
  return within(document.querySelector('nav[aria-label="面包屑"]')!);
}

function dialog() {
  return within(screen.getByRole('dialog'));
}

/** 打开某张卡片的编辑抽屉。 */
async function openEditor(title: string): Promise<void> {
  fireEvent.click(await boardArea().findByRole('button', { name: `编辑「${title}」` }));
  await screen.findByRole('dialog');
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});

describe('App 导航', () => {
  it('根看板：面包屑只有一段，点卡片进子看板并换掉面包屑与看板内容', async () => {
    createFakeApi(fixtures);
    render(<App />);

    // 根看板：面包屑只有「根看板」一段，且是当前位置。
    expect(breadcrumbNav().getByText('根看板').getAttribute('aria-current')).toBe('page');
    expect(await boardArea().findByText('支付对账')).toBeTruthy();
    // 文件树同时加载出来（同名任务在卡片与树里各有一份，所以按 aside 取）。
    const tree = within(document.querySelector('aside')!);
    expect(await tree.findByText('重构登录')).toBeTruthy();

    fireEvent.click(boardArea().getByText('支付对账'));

    await waitFor(() => expect(window.location.pathname).toBe('/board/b'));
    expect(await boardArea().findByText('对账脚本')).toBeTruthy();
    expect(breadcrumbNav().getByText('支付对账').getAttribute('aria-current')).toBe('page');
    // 上一段变回可点的按钮：面包屑与后退键行为一致。
    fireEvent.click(breadcrumbNav().getByRole('button', { name: '根看板' }));

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(await boardArea().findByText('支付对账')).toBeTruthy();
  });

  it('进到子看板后树里对应的节点是选中态', async () => {
    createFakeApi(fixtures);
    window.history.replaceState(null, '', '/board/b');
    render(<App />);

    const tree = within(document.querySelector('aside')!);
    const selected = await tree.findByText('支付对账');

    expect(selected.getAttribute('aria-current')).toBe('page');
    expect(tree.getByText('重构登录').getAttribute('aria-current')).toBeNull();
  });

  it('地址认不出来时给一条回根看板的路，而不是显示根看板', async () => {
    createFakeApi(fixtures);
    window.history.replaceState(null, '', '/nonsense');
    render(<App />);

    expect(screen.getByText('地址认不出来：/nonsense')).toBeTruthy();
    expect(screen.queryByText('支付对账')).toBeNull();

    const historyLength = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: '回根看板' }));

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    // 坏地址是被替换掉的，不是压进历史：后退不该回到那张「认不出来」的页面。
    expect(window.history.length).toBe(historyLength);
    expect(await boardArea().findByText('支付对账')).toBeTruthy();
  });

  it('任务不存在时显示后端文案，面包屑保持空白而不是半截', async () => {
    createFakeApi(fixtures);
    window.history.replaceState(null, '', '/board/missing');
    render(<App />);

    expect(await boardArea().findByText('任务不存在')).toBeTruthy();
    expect(boardArea().getByRole('button', { name: '重试' })).toBeTruthy();
    expect(breadcrumbNav().queryByText('根看板')).toBeNull();
  });
});

describe('App 增删改', () => {
  it('新建任务：Enter 提交后卡片出现，文件树也重取一次', async () => {
    const api = createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');
    const treeCallsBefore = api.calls.filter((call) => call.url.startsWith('/api/tree')).length;

    fireEvent.click(boardArea().getByRole('button', { name: '在「待办」新建任务' }));
    const input = boardArea().getByRole('textbox', { name: '在「待办」新建任务' });
    fireEvent.change(input, { target: { value: '  补迁移测试  ' } });
    fireEvent.submit(input.closest('form')!);

    expect(await boardArea().findByText('补迁移测试')).toBeTruthy();
    const post = api.calls.find((call) => call.method === 'POST');
    // 标题两端空格由后端 trim，前端先 trim 一次，请求里不留空格。
    expect(post?.body).toEqual({ parentId: null, columnId: 'todo', title: '补迁移测试' });
    // 新建之后树必须重取，否则侧栏里看不到刚建的任务（D34 遗留的那条）。
    await waitFor(() =>
      expect(api.calls.filter((call) => call.url.startsWith('/api/tree')).length).toBe(
        treeCallsBefore + 1,
      ),
    );
    expect(screen.getAllByText('补迁移测试').length).toBeGreaterThan(1);
  });

  it('在某个任务的看板里新建的是它的子任务（parentId 是当前看板）', async () => {
    const api = createFakeApi(fixtures);
    window.history.replaceState(null, '', '/board/b');
    render(<App />);
    await boardArea().findByText('对账脚本');

    fireEvent.click(boardArea().getByRole('button', { name: '在「进行中」新建任务' }));
    const input = boardArea().getByRole('textbox', { name: '在「进行中」新建任务' });
    fireEvent.change(input, { target: { value: '跑一次全量对账' } });
    fireEvent.submit(input.closest('form')!);

    expect(await boardArea().findByText('跑一次全量对账')).toBeTruthy();
    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ parentId: 'b', columnId: 'doing', title: '跑一次全量对账' });
  });

  it('新建失败时留在输入行里显示后端文案，表单不收起', async () => {
    createFakeApi(fixtures, { postError: '标题不能为空' });
    render(<App />);
    await boardArea().findByText('支付对账');

    fireEvent.click(boardArea().getByRole('button', { name: '在「待办」新建任务' }));
    const input = boardArea().getByRole('textbox', { name: '在「待办」新建任务' });
    fireEvent.change(input, { target: { value: '补迁移测试' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByText('标题不能为空')).toBeTruthy();
    // 失败不该把输入行收掉：用户还要把标题改对再试一次。
    expect(boardArea().getByRole('textbox', { name: '在「待办」新建任务' })).toBeTruthy();
  });

  it('标题为空时「添加」按钮是禁用的', async () => {
    createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');

    fireEvent.click(boardArea().getByRole('button', { name: '在「待办」新建任务' }));
    const input = boardArea().getByRole('textbox', { name: '在「待办」新建任务' });

    expect((boardArea().getByRole('button', { name: '添加' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: '  ' } });
    expect((boardArea().getByRole('button', { name: '添加' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('编辑任务：抽屉保存改标题与工期，卡片跟着更新', async () => {
    const api = createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');

    await openEditor('支付对账');
    fireEvent.change(dialog().getByDisplayValue('支付对账'), { target: { value: '支付对账 v2' } });
    fireEvent.change(dialog().getByLabelText('天'), { target: { value: '2' } });
    fireEvent.change(dialog().getByLabelText('分'), { target: { value: '30' } });
    // 三段换算的实时预览：2 天 30 分 = 990 分钟。
    expect(dialog().getByText('工期 2 天 30 分')).toBeTruthy();

    fireEvent.click(dialog().getByRole('button', { name: '保存' }));

    expect(await dialog().findByText('已保存')).toBeTruthy();
    const patch = api.calls.find((call) => call.method === 'PATCH' && !call.url.endsWith('/archive'));
    expect(patch?.url).toBe('/api/tasks/b');
    expect(patch?.body).toEqual({
      title: '支付对账 v2',
      description: '',
      durationMinutes: 990,
    });

    // 看板被静默重取，卡片上新标题与工期都到位，抽屉仍然开着。
    expect(await boardArea().findByText('支付对账 v2')).toBeTruthy();
    expect(boardArea().getByText('工期 2 天 30 分')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('保存后草稿换成服务端归一化后的值（标题 trim、工期折算）', async () => {
    createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');

    await openEditor('支付对账');
    fireEvent.change(dialog().getByDisplayValue('支付对账'), { target: { value: '  支付对账  ' } });
    fireEvent.change(dialog().getByLabelText('小时'), { target: { value: '9' } });
    fireEvent.click(dialog().getByRole('button', { name: '保存' }));

    expect(await dialog().findByText('已保存')).toBeTruthy();
    // 后端把标题 trim 了、9 小时折成 1 天 1 小时：输入框不能还留着原始输入。
    expect((dialog().getByDisplayValue('支付对账') as HTMLInputElement).value).toBe('支付对账');
    expect((dialog().getByLabelText('天') as HTMLInputElement).value).toBe('1');
    expect((dialog().getByLabelText('小时') as HTMLInputElement).value).toBe('1');
  });

  it('抽屉整体是 form：标题框按 Enter 与点「保存」走同一条路', async () => {
    const api = createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');

    await openEditor('支付对账');
    const titleInput = dialog().getByDisplayValue('支付对账');
    const form = titleInput.closest('form');
    expect(form).not.toBeNull();
    expect(form!.contains(dialog().getByRole('button', { name: '保存' }))).toBe(true);

    fireEvent.change(titleInput, { target: { value: '支付对账 v3' } });
    // jsdom 不做隐式提交，这里直接提交表单；浏览器里标题框按 Enter 就是这件事。
    fireEvent.submit(form!);

    expect(await dialog().findByText('已保存')).toBeTruthy();
    expect(api.calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({
      title: '支付对账 v3',
    });
  });

  it('写后是静默重取：新数据路上时旧卡片留在原地，不闪「加载中」', async () => {
    const api = createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');

    // 卡住写之后的看板读请求，好观察这段窗口。
    const release = api.holdBoardReads();

    await openEditor('支付对账');
    fireEvent.change(dialog().getByDisplayValue('支付对账'), { target: { value: '支付对账 v2' } });
    fireEvent.click(dialog().getByRole('button', { name: '保存' }));
    // 写响应已经回来（抽屉显示「已保存」），但看板的重取还挂在路上。
    expect(await dialog().findByText('已保存')).toBeTruthy();

    // 这一条钉住 D35 的 quiet 语义：换成响亮重取（reload）时看板会退回加载态，这里就失败。
    expect(boardArea().queryByText('加载中…')).toBeNull();
    expect(boardArea().getByText('支付对账')).toBeTruthy();

    release();
    // 重取结果到了之后旧卡片被换成新的。
    expect(await boardArea().findByText('支付对账 v2')).toBeTruthy();
  });

  it('归档：默认从列里消失，打开「显示已归档」后带归档样式回到列里，抽屉里可取消归档', async () => {
    const api = createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');

    await openEditor('支付对账');
    fireEvent.click(dialog().getByRole('button', { name: '归档' }));

    expect(await dialog().findByText('这个任务已归档。取消归档后才能改标题、描述与工期。')).toBeTruthy();
    await waitFor(() => expect(boardArea().queryByText('支付对账')).toBeNull());
    expect(api.calls.some((call) => call.url === '/api/tasks/b/archive')).toBe(true);
    // 已归档的抽屉里不再给「归档」入口：它与「取消归档」同屏，点下去还是幂等空操作。
    expect(dialog().queryByRole('button', { name: '归档' })).toBeNull();
    expect(dialog().getByRole('button', { name: '取消归档' })).toBeTruthy();
    expect(dialog().getByRole('button', { name: '删除' })).toBeTruthy();

    // 打开总开关：看板列里也带归档卡片，否则界面上没有取消归档的入口。
    fireEvent.click(screen.getByRole('checkbox', { name: '显示已归档' }));

    expect(await boardArea().findByText('支付对账')).toBeTruthy();
    const archivedCard = within(boardArea().getByText('支付对账').closest('article')!);
    expect(archivedCard.getByText('归档')).toBeTruthy();
    expect(archivedCard.getByText('支付对账').closest('article')?.className).toContain(
      'border-dashed',
    );
    expect(window.localStorage.getItem('kanban.tree.showArchived')).toBe('true');
    expect(api.calls.some((call) => call.url === '/api/board?includeArchived=1')).toBe(true);

    fireEvent.click(dialog().getByRole('button', { name: '取消归档' }));

    await waitFor(() =>
      expect(dialog().queryByText('这个任务已归档。取消归档后才能改标题、描述与工期。')).toBeNull(),
    );
    expect(dialog().getByRole('button', { name: '保存' })).toBeTruthy();
  });

  it('删除：先内联二次确认，确认后卡片消失', async () => {
    const api = createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');

    await openEditor('支付对账');
    fireEvent.click(dialog().getByRole('button', { name: '删除' }));

    // 内联确认，不是浏览器原生 confirm。
    expect(dialog().getByText('确认删除？会连带删除全部子任务')).toBeTruthy();
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);

    fireEvent.click(dialog().getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(boardArea().queryByText('支付对账')).toBeNull());
    expect(api.calls.some((call) => call.method === 'DELETE' && call.url === '/api/tasks/b')).toBe(true);
    // 删掉的正是抽屉里那个任务，所以抽屉自己收起来。
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('抽屉的遮罩、关闭按钮与 Esc 都能关掉面板', async () => {
    createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');

    await openEditor('支付对账');
    fireEvent.click(screen.getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openEditor('支付对账');
    fireEvent.click(dialog().getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openEditor('支付对账');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('抽屉打开时点面包屑切走，抽屉自动收起', async () => {
    createFakeApi(fixtures);
    window.history.replaceState(null, '', '/board/b');
    render(<App />);
    await boardArea().findByText('对账脚本');

    await openEditor('对账脚本');
    // 遮罩盖住整块看板，面包屑是抽屉打开时唯一还能点的导航（这也是不加 aria-modal 的原因）。
    fireEvent.click(breadcrumbNav().getByRole('button', { name: '根看板' }));

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('抽屉打开时按浏览器后退，抽屉同样收起', async () => {
    createFakeApi(fixtures);
    render(<App />);
    await boardArea().findByText('支付对账');

    await openEditor('支付对账');
    // 后退/前进只改 URL，useRoute 靠 popstate 把地址同步回 state，抽屉随之收到新的 boardId。
    window.history.pushState(null, '', '/board/a');
    fireEvent.popState(window);

    await waitFor(() => expect(window.location.pathname).toBe('/board/a'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
