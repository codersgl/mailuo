import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../src/components/Sidebar';
import type { TreeTask } from '../src/api/types';

/**
 * 文件树的行为：层级与徽标、点名字导航、三角只折叠、归档样式与开关、
 * 「当前看板被折叠在祖先里时自动展开」、写操作后的静默重取、以及本地偏好坏掉时的兜底。
 *
 * 开关本身由 BoardPage 持有（看板列也认它），所以这里只测「受控显示 + 回调」，
 * 落 localStorage 的行为在 App.test.tsx 里覆盖。
 */

const treeTasks: TreeTask[] = [
  { id: 'a', parentId: null, title: '重构登录', columnId: 'doing', archivedAt: null },
  { id: 'a1', parentId: 'a', title: '抽出鉴权中间件', columnId: 'done', archivedAt: null },
  { id: 'a2', parentId: 'a', title: '前端表单改造', columnId: 'doing', archivedAt: null },
  { id: 'a1x', parentId: 'a1', title: '补单元测试', columnId: 'done', archivedAt: null },
  { id: 'b', parentId: null, title: '支付对账', columnId: 'todo', archivedAt: null },
  { id: 'b1', parentId: 'b', title: '对账脚本', columnId: 'todo', archivedAt: null },
  {
    id: 'z',
    parentId: null,
    title: '旧版导出',
    columnId: 'todo',
    archivedAt: '2026-09-22T00:00:00.000Z',
  },
];

/** 后端的实际行为：includeArchived 关着时不返回归档节点。 */
function visibleOf(tasks: TreeTask[]): TreeTask[] {
  return tasks.filter((task) => task.archivedAt === null);
}

let requested: string[] = [];

function stubTreeFetch(tasks: TreeTask[] = treeTasks): void {
  requested = [];
  vi.stubGlobal('fetch', (input: string) => {
    const url = String(input);
    requested.push(url);
    const visible = url.includes('includeArchived') ? tasks : visibleOf(tasks);
    return Promise.resolve(jsonResponse({ tasks: visible }));
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderSidebar(
  boardId: string | null = null,
  options: { showArchived?: boolean; refreshToken?: number } = {},
) {
  const onNavigate = vi.fn();
  const onShowArchivedChange = vi.fn();
  const props = {
    boardId,
    onNavigate,
    showArchived: options.showArchived ?? false,
    onShowArchivedChange,
    refreshToken: options.refreshToken ?? 0,
  };
  const view = render(<Sidebar {...props} />);
  return { onNavigate, onShowArchivedChange, props, ...view };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});

describe('Sidebar', () => {
  it('按层级渲染任务，并有子任务的节点显示完成/总数徽标', async () => {
    stubTreeFetch();
    renderSidebar();

    expect(await screen.findByText('抽出鉴权中间件')).toBeTruthy();
    // a 的两个未归档子任务：a1 在完成列、a2 在进行中。
    expect(screen.getByText('1/2')).toBeTruthy();
    // 叶子用点表示所在列，而不是 0/0 徽标。
    expect(screen.getByRole('img', { name: '已完成' })).toBeTruthy();
    expect(screen.queryByText('0/0')).toBeNull();
  });

  it('点任务名交给 onNavigate，点三角只折叠', async () => {
    stubTreeFetch();
    const { onNavigate } = renderSidebar();

    fireEvent.click(await screen.findByText('前端表单改造'));
    expect(onNavigate).toHaveBeenCalledWith('a2');
    // 折叠是三角的事，点名字不该顺带改展开状态。
    expect(screen.getByText('抽出鉴权中间件')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '折叠「重构登录」' }));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('抽出鉴权中间件')).toBeNull();
    expect(screen.getByText('已折叠')).toBeTruthy();
    expect(window.localStorage.getItem('kanban.tree.collapsed')).toBe(JSON.stringify(['a']));
  });

  it('开关关着时请求不带 includeArchived，归档节点不出现在树里', async () => {
    stubTreeFetch();
    renderSidebar();

    expect(await screen.findByText('重构登录')).toBeTruthy();
    expect(requested).toEqual(['/api/tree']);
    expect(screen.queryByText('旧版导出')).toBeNull();
  });

  it('开关打开时带 includeArchived=1 取树，归档节点带「归档」标记', async () => {
    stubTreeFetch();
    renderSidebar(null, { showArchived: true });

    expect(await screen.findByText('旧版导出')).toBeTruthy();
    expect(requested).toEqual(['/api/tree?includeArchived=1']);
    expect(screen.getByText('归档')).toBeTruthy();
  });

  it('点开关把新值交给上层，自己不落 localStorage', async () => {
    stubTreeFetch();
    const { onShowArchivedChange } = renderSidebar();
    await screen.findByText('重构登录');

    fireEvent.click(screen.getByRole('checkbox', { name: '显示已归档' }));

    expect(onShowArchivedChange).toHaveBeenCalledWith(true);
    // 开关状态是 BoardPage 的 usePersistentState 在存，Sidebar 不再自己写一份。
    expect(window.localStorage.getItem('kanban.tree.showArchived')).toBeNull();
  });

  it('refreshToken 变化时静默重取：旧树留在屏幕上，不闪「加载中」', async () => {
    const resolvers: Array<(tasks: TreeTask[]) => void> = [];
    requested = [];
    vi.stubGlobal('fetch', (input: string) => {
      requested.push(String(input));
      return new Promise<Response>((resolve) => {
        resolvers.push((tasks) => resolve(jsonResponse({ tasks })));
      });
    });

    const { props, rerender } = renderSidebar();
    await waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0]?.(visibleOf(treeTasks));
    expect(await screen.findByText('重构登录')).toBeTruthy();

    rerender(<Sidebar {...props} refreshToken={1} />);
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // 第二次请求还在飞：树不能被清成加载态，否则写一次标题文件树就会闪一下。
    expect(screen.queryByText('加载中…')).toBeNull();
    expect(screen.getByText('重构登录')).toBeTruthy();

    resolvers[1]?.(visibleOf(treeTasks));
    await waitFor(() => expect(requested).toEqual(['/api/tree', '/api/tree']));
  });

  it('当前看板的祖先被折叠过时自动展开，用户折叠的其他分支保持折叠', async () => {
    window.localStorage.setItem('kanban.tree.collapsed', JSON.stringify(['a', 'b']));
    stubTreeFetch();
    renderSidebar('a1x');

    // a 是 a1x 的祖先，必须展开，否则用户看不到自己在哪里。
    expect(await screen.findByText('补单元测试')).toBeTruthy();
    // b 与当前看板无关，保持折叠。
    expect(screen.getByRole('button', { name: '展开「支付对账」' })).toBeTruthy();
    /**
     * 这一条必须等，不能像上面那样直接断言：展开是渲染出来的，落盘却发生在
     * usePersistentState 的 effect 里，也就是那次渲染提交之后。
     * 直接断言会偶发读到还没被改写的旧值（负载高时约十次里错两次，见 docs/decisions.md D44）。
     */
    await waitFor(() =>
      expect(window.localStorage.getItem('kanban.tree.collapsed')).toBe(JSON.stringify(['b'])),
    );
  });

  it('选中的节点用 aria-current 标出', async () => {
    stubTreeFetch();
    renderSidebar('a2');

    const name = await screen.findByText('前端表单改造');
    expect(name.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('重构登录').getAttribute('aria-current')).toBeNull();
  });

  it('根看板时树里没有选中项（根看板不是任务）', async () => {
    stubTreeFetch();
    renderSidebar(null);

    const name = await screen.findByText('重构登录');
    expect(name.getAttribute('aria-current')).toBeNull();
  });

  it('当前看板不在树里（例如直接打开归档任务的地址）时给一行说明', async () => {
    stubTreeFetch();
    renderSidebar('hidden-board');

    expect(await screen.findByText('当前看板不在树里，可能已归档')).toBeTruthy();
  });

  it('当前看板在树里时没有那行说明', async () => {
    stubTreeFetch();
    renderSidebar('a2');

    await screen.findByText('前端表单改造');
    expect(screen.queryByText('当前看板不在树里，可能已归档')).toBeNull();
  });

  it('折叠偏好里混进非字符串时整份丢弃，回到全展开', async () => {
    // 形状校验只查「是不是数组」的话，['a', 1] 会被采纳成折叠 a，这里就会失败。
    window.localStorage.setItem('kanban.tree.collapsed', JSON.stringify(['a', 1]));
    stubTreeFetch();
    renderSidebar();

    expect(await screen.findByText('补单元测试')).toBeTruthy();
    expect(screen.getByRole('button', { name: '折叠「重构登录」' })).toBeTruthy();
  });

  it('选中一个归档节点时，选中色不被归档的弱化色覆盖', async () => {
    stubTreeFetch();
    renderSidebar('z', { showArchived: true });

    const name = await screen.findByText('旧版导出');
    // 行上同时挂 bg-accent-weak（选中）和 text-ink-3（归档弱化）时，生成 CSS 里 ink-3 在后，
    // 会把选中文字的颜色吃掉，所以归档那组类不能作用在选中行上。这里用类名钉住这个取舍。
    const row = name.closest('div')!;
    expect(row.className).toContain('bg-accent-weak');
    expect(row.className).not.toContain('text-ink-3');
    // 归档标记本身仍然显示。
    expect(screen.getByText('归档')).toBeTruthy();
  });

  it('取树失败时显示后端文案并可重试', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse({ error: '服务挂了' }, 500)));
    const { onNavigate } = renderSidebar();

    expect(await screen.findByText('服务挂了')).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText('重构登录')).toBeNull();
  });

  it('空库时给一行弱提示', async () => {
    stubTreeFetch([]);
    renderSidebar();

    expect(await screen.findByText('暂无任务')).toBeTruthy();
  });

  describe('面板收起', () => {
    /**
     * 面板本体。`aside` 在 ARIA 里是 complementary 角色，`getByLabelText` 只认表单控件，
     * 所以用角色 + 名字取；收起后名字会带上「已收起」，所以这里匹配前缀。
     */
    const panel = () => screen.getByRole('complementary', { name: /^文件树/ });
    /**
     * 树是不是真的看得见。`hidden` 走的是 display:none，而 jsdom 自己不算布局、
     * `toBeVisible` 也认不出 hidden 属性，所以按最近一层带 hidden 的祖先判断。
     */
    const isTreeVisible = () =>
      screen.getByText('重构登录').closest('[hidden]') === null;

    it('点收起：面板变窄条、开关收起、树被隐藏但不再取数，偏好落 localStorage', async () => {
      stubTreeFetch();
      renderSidebar();
      await screen.findByText('重构登录');

      expect(panel().style.width).toBe('252px');
      fireEvent.click(screen.getByRole('button', { name: '收起文件树' }));

      expect(panel().style.width).toBe('44px');
      // 收起后无障碍名字也会变，用户（读屏）能听出这块现在是收着的。
      expect(panel().getAttribute('aria-label')).toBe('文件树（已收起）');
      // 树留在 DOM 里（展开是瞬时的），但用 hidden 藏起来：display:none 之后它不再参与
      // 读屏与 Tab 顺序，所以这里断言的是「不可见」，不是「节点不存在」。
      expect(isTreeVisible()).toBe(false);
      expect(screen.getByText('重构登录')).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: '显示已归档' })).toBeNull();
      // fireEvent.click 由 act 包着，落盘的 effect 在它返回前就跑完了（见 docs/decisions.md D44）。
      expect(window.localStorage.getItem('kanban.tree.panelCollapsed')).toBe('true');

      // 同一个按钮换名字与图标方向，再点一次就回到展开，且不重新发请求。
      fireEvent.click(screen.getByRole('button', { name: '展开文件树' }));
      expect(panel().style.width).toBe('252px');
      expect(isTreeVisible()).toBe(true);
      expect(window.localStorage.getItem('kanban.tree.panelCollapsed')).toBe('false');
      expect(requested).toEqual(['/api/tree']);
    });

    it('收起时焦点从被隐藏的树接到按钮上', async () => {
      stubTreeFetch();
      renderSidebar();
      const node = await screen.findByText('前端表单改造');
      node.focus();

      fireEvent.click(screen.getByRole('button', { name: '收起文件树' }));

      // 焦点当时在树里，树整块被移除后不接管的话焦点会掉回 body，键盘用户下一次 Tab 从头开始。
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开文件树' }));
    });

    it('本地偏好说收起时首屏就是窄条，树照常取到、展开即用', async () => {
      window.localStorage.setItem('kanban.tree.panelCollapsed', 'true');
      stubTreeFetch();
      renderSidebar();

      expect(panel().style.width).toBe('44px');
      // 树的数据仍然照取（useTree 在 Sidebar 里，不随收起与否开关）：
      // 代价是收着也发一次 /api/tree，换来的是点展开时数据已经在手上、不闪一帧加载态。
      await waitFor(() => expect(requested).toEqual(['/api/tree']));

      fireEvent.click(screen.getByRole('button', { name: '展开文件树' }));

      expect(panel().style.width).toBe('252px');
      expect(isTreeVisible()).toBe(true);
      expect(screen.getByText('重构登录')).toBeTruthy();
      // 展开只是把已经取到的树画出来，不重新请求。
      expect(requested).toEqual(['/api/tree']);
    });

    it('本地偏好不是 boolean 时按展开算', async () => {
      window.localStorage.setItem('kanban.tree.panelCollapsed', '"yes"');
      stubTreeFetch();
      renderSidebar();

      expect(panel().style.width).toBe('252px');
      expect(await screen.findByText('重构登录')).toBeTruthy();
    });
  });
});
