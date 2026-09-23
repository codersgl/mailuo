import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../src/components/Sidebar';
import type { TreeTask } from '../src/api/types';

/**
 * 任务树的行为：层级与徽标、点名字导航、三角只折叠、归档样式与开关、
 * 「当前看板被折叠在祖先里时自动展开」、写操作后的静默重取、以及本地偏好坏掉时的兜底。
 *
 * 开关本身由 BoardPage 持有（看板列也认它），所以这里只测「受控显示 + 回调」，
 * 落 localStorage 的行为在 App.test.tsx 里覆盖。
 */

const treeTasks: TreeTask[] = [
  { id: 'a', parentId: null, title: '重构登录', columnId: 'doing', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
  { id: 'a1', parentId: 'a', title: '抽出鉴权中间件', columnId: 'done', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
  { id: 'a2', parentId: 'a', title: '前端表单改造', columnId: 'doing', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
  { id: 'a1x', parentId: 'a1', title: '补单元测试', columnId: 'done', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
  { id: 'b', parentId: null, title: '支付对账', columnId: 'todo', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
  { id: 'b1', parentId: 'b', title: '对账脚本', columnId: 'todo', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
  {
    id: 'z',
    parentId: null,
    title: '旧版导出',
    columnId: 'todo',
    archivedAt: '2026-09-22T00:00:00.000Z',
    durationMinutes: null,
    spentMinutes: 0,
    runningSince: null,
  },
];

/** 造一个树节点。默认待办列、未归档、未估工期，只在用例需要时覆盖。 */
function treeTask(
  id: string,
  parentId: string | null,
  title: string,
  overrides: Partial<TreeTask> = {},
): TreeTask {
  return {
    id,
    parentId,
    title,
    columnId: 'todo',
    archivedAt: null,
    durationMinutes: null,
    spentMinutes: 0,
    runningSince: null,
    ...overrides,
  };
}

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
  options: { showArchived?: boolean; refreshToken?: number; strict?: boolean } = {},
) {
  const onNavigate = vi.fn();
  const onShowArchivedChange = vi.fn();
  const onParentChanged = vi.fn();
  const props = {
    boardId,
    onNavigate,
    showArchived: options.showArchived ?? false,
    onShowArchivedChange,
    refreshToken: options.refreshToken ?? 0,
    onParentChanged,
  };
  /**
   * `strict` 用于「挂载时不该做副作用」这一类用例：真实入口 main.tsx 开着 StrictMode，
   * 它会把挂载 effect 跑两遍。只在那些用例里打开，免得其余 15 条的行为被它改掉。
   */
  const view = render(
    options.strict ? (
      <StrictMode>
        <Sidebar {...props} />
      </StrictMode>
    ) : (
      <Sidebar {...props} />
    ),
  );
  return { onNavigate, onShowArchivedChange, onParentChanged, props, ...view };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // 落点用例会给 document 装一个 elementFromPoint 替身（jsdom 本来没有这个 API），
  // 这里统一拆掉，免得漏给后面的用例。
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
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

  it('折叠徽标与展开态同一口径：只数未归档子任务', async () => {
    // 一个未归档子任务 + 一个已归档子任务，且打开「显示已归档」（否则归档节点根本不在树里）。
    const mixed: TreeTask[] = [
      treeTask('a', null, '重构登录'),
      treeTask('a1', 'a', '未归档子任务'),
      treeTask('a2', 'a', '已归档子任务', { columnId: 'done', archivedAt: '2026-09-22T00:00:00.000Z' }),
    ];
    stubTreeFetch(mixed);
    renderSidebar(null, { showArchived: true });
    await screen.findByText('重构登录');

    fireEvent.click(screen.getByRole('button', { name: '折叠「重构登录」' }));

    // 老实现显示 children.length（2），与展开后的「0/1」对不上。归档的那部分只在 title 里说明。
    expect(screen.getByTitle('有 1 个子任务（另有 1 个已归档），当前已折叠')).toBeTruthy();
    expect(screen.queryByText('2')).toBeNull();
  });

  it('下半区落到根层时，树顶给出「挂到根看板」的落点提示', async () => {
    stubTreeFetch();
    renderSidebar();
    // b（支付对账）是顶层节点：它的下半区意味着「与它同级」= 挂到根看板，树里没有行可高亮。
    await screen.findByText('支付对账');

    /**
     * jsdom 没有布局，也没有 elementFromPoint，所以用一个替身告诉 useTreeDrag
     * 「指针压在 b 这一行的下半区」（行的假矩形高 20，从 y=0 起，y=15 算下半区）。
     * 被拖的是 b 的子任务 b1（对账脚本）：drag 自己压到自己身上会被判成无效落点。
     */
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => {
      const row = {
        getAttribute: () => 'b',
        getBoundingClientRect: () => ({ top: 0, height: 20 }),
      };
      return { closest: () => row } as unknown as Element;
    };

    const row = screen.getByText('对账脚本');
    fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 40, clientY: 15 });

    expect(screen.getByText('挂到根看板')).toBeTruthy();

    const hint = screen.getByText('挂到根看板').closest('[data-root-drop-hint]');
    expect(hint).not.toBeNull();
    /**
     * 提示必须在滚动容器**之外**（绝对定位覆盖在树顶），不能按文档流插在列表里：
     * 那种写法在提示出现时把所有行下推一行高（26px），而落点判定每次 pointermove 都重读
     * 实时矩形，于是同一指针位置会算出不同的行——提示闪、松手还可能落空（审阅实测的反馈环）。
     */
    expect(hint?.className).toContain('absolute');
    const scroller = hint?.parentElement?.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller?.contains(hint ?? null)).toBe(false);

    // 松手后提示要消失：它只在拖动过程中有意义。
    fireEvent.pointerUp(document, { clientX: 40, clientY: 15 });
    await waitFor(() => expect(screen.queryByText('挂到根看板')).toBeNull());

    // 对照：落到某个节点下时不出现这一行——那种落点高亮的是那一行本身（a1 的上半区）。
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => {
      const row = {
        getAttribute: () => 'a1',
        getBoundingClientRect: () => ({ top: 0, height: 20 }),
      };
      return { closest: () => row } as unknown as Element;
    };
    fireEvent.pointerDown(screen.getByText('补单元测试'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 40, clientY: 5 });

    expect(screen.queryByText('挂到根看板')).toBeNull();
  });

  it('树拖动改父级成功后交给上层统一刷新，而不是只重取自己那棵树', async () => {
    stubTreeFetch();
    const { onParentChanged } = renderSidebar();
    await screen.findByText('补单元测试');

    // 指针压在 b 这一行的上半区：落点是「成为 b 的子节点」。
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => {
      const row = { getAttribute: () => 'b', getBoundingClientRect: () => ({ top: 0, height: 20 }) };
      return { closest: () => row } as unknown as Element;
    };

    fireEvent.pointerDown(screen.getByText('补单元测试'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 40, clientY: 5 });
    fireEvent.pointerUp(document, { clientX: 40, clientY: 5 });

    await waitFor(() => expect(onParentChanged).toHaveBeenCalledTimes(1));
    // 请求真的发出去了；被拖的正是 a1x，它的当前列是 done。
    expect(requested.some((url) => url.endsWith('/parent'))).toBe(true);
  });

  it('子任务全部已归档时，折叠态不显示「0」徽标（与展开态一样没有徽标）', async () => {
    const allArchived: TreeTask[] = [
      treeTask('a', null, '重构登录'),
      treeTask('a1', 'a', '已归档子任务', { archivedAt: '2026-09-22T00:00:00.000Z' }),
    ];
    stubTreeFetch(allArchived);
    renderSidebar(null, { showArchived: true });
    await screen.findByText('重构登录');

    fireEvent.click(screen.getByRole('button', { name: '折叠「重构登录」' }));

    // 「已折叠」还在（三角说明它确实有子任务），但没有数字徽标：展开态也没有。
    expect(screen.getByText('已折叠')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
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

    // 第二次请求还在飞：树不能被清成加载态，否则改一次标题、任务树就会闪一下。
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

  /**
   * 面板的可见标题。这条断言必须直接问 heading 角色：下面 `panel()` 取的是 aside 的
   * `aria-label`，而 aria-label 会盖住内容，标题被改错时「按名字取面板」照样绿
   * （审阅的变异 M2：把标题改回「文件树」，全量用例无一变红）。
   * 改名的核心字符串就是这一处，所以单独钉一条。
   */
  it('面板标题是「任务树」', async () => {
    stubTreeFetch();
    renderSidebar();

    expect(await screen.findByText('重构登录')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '任务树' })).toBeTruthy();
  });

  describe('面板收起', () => {
    /**
     * 面板本体。`aside` 在 ARIA 里是 complementary 角色，`getByLabelText` 只认表单控件，
     * 所以用角色 + 名字取。名字固定是「任务树」，不随收起状态变。
     */
    const panel = () => screen.getByRole('complementary', { name: '任务树' });
    /** 收起按钮（展开与收起共用同一个，名字随状态变）。 */
    const toggle = () => screen.getByRole('button', { name: /(收起|展开)任务树/ });
    /**
     * 树在不在无障碍树里。不用 `closest('[hidden]')` 这种结构判断，而是问测试库
     * 「还能不能按角色拿到树里的按钮」——这正是读屏与 Tab 顺序关心的问题。
     * 注意 jsdom 不模拟 display:none 的命中测试，所以这个断言证明的是语义，不是像素。
     */
    const isTreeVisible = () =>
      screen.queryByRole('button', { name: '折叠「重构登录」' }) !== null;

    it('点收起：面板变窄条、开关收起、树被隐藏但不再取数，偏好落 localStorage', async () => {
      stubTreeFetch();
      renderSidebar();
      await screen.findByText('重构登录');

      expect(panel().style.width).toBe('252px');
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(toggle());

      expect(panel().style.width).toBe('44px');
      // aria-expanded 表达被控内容可不可见，所以收起时是 false（与图标方向相反是正常的）。
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      // aria-controls 指向被控制的那棵树，读屏用户能从按钮跳过去。
      const controlled = toggle().getAttribute('aria-controls');
      expect(controlled).toBeTruthy();
      expect(document.getElementById(controlled!)?.hidden).toBe(true);
      // 树留在 DOM 里（展开是瞬时的），但用 hidden 藏起来：display:none 之后它不再参与
      // 读屏与 Tab 顺序，所以这里断言的是「不可见」，不是「节点不存在」。
      expect(isTreeVisible()).toBe(false);
      // 标题只是 sr-only，仍留在无障碍树里：收起时读屏用户靠标题导航还能找到这块面板。
      expect(screen.getByRole('heading', { name: '任务树' })).toBeTruthy();
      expect(screen.getByText('重构登录')).toBeTruthy();
      expect(screen.queryByRole('checkbox', { name: '显示已归档' })).toBeNull();
      // fireEvent.click 由 act 包着，落盘的 effect 在它返回前就跑完了（见 docs/decisions.md D44）。
      expect(window.localStorage.getItem('kanban.tree.panelCollapsed')).toBe('true');

      // 同一个按钮换名字与图标方向，再点一次就回到展开，且不重新发请求。
      fireEvent.click(toggle());
      expect(panel().style.width).toBe('252px');
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      expect(isTreeVisible()).toBe(true);
      expect(window.localStorage.getItem('kanban.tree.panelCollapsed')).toBe('false');
      expect(requested).toEqual(['/api/tree']);
    });

    it('收起时焦点从被隐藏的树接到按钮上', async () => {
      stubTreeFetch();
      renderSidebar();
      const node = await screen.findByText('前端表单改造');
      node.focus();

      fireEvent.click(toggle());

      // 焦点当时在树里，树不可见之后不接管的话焦点会掉回 body，键盘用户下一次 Tab 从头开始。
      expect(document.activeElement).toBe(toggle());
    });

    it('首屏收起时不抢焦点（StrictMode 下也不抢），树照常取到', async () => {
      // StrictMode 是真实入口 main.tsx 的配置，它会把挂载 effect 跑两遍。
      // 之前 effect 只看 `collapsed`，挂载那次就会聚焦，用户按第一次 Tab 会跳过整个顶栏
      // 落到看板里（审阅实测）；现在只认 false → true 这一跳。
      window.localStorage.setItem('kanban.tree.panelCollapsed', 'true');
      stubTreeFetch();
      renderSidebar(null, { strict: true });

      expect(panel().style.width).toBe('44px');
      expect(document.activeElement).toBe(document.body);
      // 树的数据仍然照取（useTree 在 Sidebar 里，不随收起与否开关）：代价是收着也发一次
      // /api/tree，换来的是点展开时数据已经在手上、不闪一帧加载态。
      // 次数只断言「至少一次」：StrictMode 会挂载两次，这个测试不替 useTree 记流水账。
      await waitFor(() => expect(requested.length).toBeGreaterThan(0));
      // 数据回来后有一次 re-render，也不该把焦点挪走。
      expect(document.activeElement).toBe(document.body);
    });

    it('本地偏好说收起时首屏就是窄条，展开即用、不重新取数', async () => {
      window.localStorage.setItem('kanban.tree.panelCollapsed', 'true');
      stubTreeFetch();
      renderSidebar();

      expect(panel().style.width).toBe('44px');
      await waitFor(() => expect(requested).toEqual(['/api/tree']));

      fireEvent.click(toggle());

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
