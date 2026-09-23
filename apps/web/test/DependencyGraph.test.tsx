import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DependencyGraph } from '../src/components/DependencyGraph';
import type { ColumnRecord, LayerSchedule, ScheduleEdge, ScheduleNode } from '../src/api/types';

/**
 * 依赖图视图。jsdom 不做布局（getBoundingClientRect 全是 0），所以这里测的是**结构**：
 * 画了几个节点、关键路径有没有用强调色、点选与悬停改的是哪些类、归档是否跟着开关走、
 * 加载/失败态下工具栏还在不在（用户能不能切回看板）。
 *
 * 真布局（分层坐标、平移缩放、连接线的实际走向）由浏览器验收覆盖，见 docs/decisions.md D50。
 */

const COLUMNS: ColumnRecord[] = [
  { id: 'todo', name: '待办', orders: 1000 },
  { id: 'doing', name: '进行中', orders: 2000 },
  { id: 'done', name: '完成', orders: 3000 },
];

function node(overrides: Partial<ScheduleNode> & Pick<ScheduleNode, 'id' | 'title'>): ScheduleNode {
  return {
    columnId: 'todo',
    durationMinutes: 60,
    archivedAt: null,
    earliestStart: 0,
    earliestFinish: 60,
    latestStart: 0,
    latestFinish: 60,
    slack: 0,
    critical: false,
    ...overrides,
  };
}

/** 一条关键链 + 一条非关键分支 + 一个已归档的前置，覆盖四种角色。 */
const SCHEDULE: LayerSchedule = {
  parentId: null,
  projectDuration: 1560,
  nodes: [
    node({
      id: 't1',
      title: '梳理旧登录流程',
      columnId: 'doing',
      durationMinutes: 480,
      earliestFinish: 480,
      // 最晚结束故意给一个与最早结束不同的值：详情卡那条「标签 → 值」配对的用例要能分辨出
      // 「最早结束」与「最晚结束」两行（值相同的话互换实现也测不出来）。
      latestFinish: 1440,
      critical: true,
    }),
    node({
      id: 't3',
      title: '实现新登录接口',
      columnId: 'doing',
      durationMinutes: null,
      earliestStart: 480,
      earliestFinish: 1440,
      latestStart: 480,
      latestFinish: 1440,
      critical: true,
    }),
    node({
      id: 't2',
      title: '调研第三方登录',
      columnId: 'done',
      durationMinutes: 240,
      earliestFinish: 240,
      latestFinish: 480,
      slack: 240,
    }),
    node({
      id: 't9',
      title: '过时的调研',
      columnId: 'todo',
      archivedAt: '2026-09-23T00:00:00.000Z',
      slack: 240,
    }),
  ],
  edges: [
    { predecessorId: 't1', successorId: 't3', critical: true },
    { predecessorId: 't2', successorId: 't3', critical: false },
    { predecessorId: 't9', successorId: 't2', critical: false },
  ],
};

function renderGraph(overrides: Partial<Parameters<typeof DependencyGraph>[0]> = {}) {
  const props = graphProps(overrides);
  return { ...render(<DependencyGraph {...props} />), props };
}

function graphProps(overrides: Partial<Parameters<typeof DependencyGraph>[0]> = {}) {
  return {
    state: { status: 'ready', data: SCHEDULE } as Parameters<typeof DependencyGraph>[0]['state'],
    view: 'graph' as const,
    onViewChange: vi.fn(),
    showArchived: false,
    columns: COLUMNS,
    onOpenTask: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

function stage(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-graph-stage]');
  if (element === null) throw new Error('没有找到图画布');
  return element;
}

function graphNode(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-graph-node="${id}"]`);
  if (element === null) throw new Error(`没有找到节点 ${id}`);
  return element;
}

/** 一条边的可见线（组里的第二个 path：第一个是透明的加粗命中区）。 */
function edgeLine(container: HTMLElement, key: string): Element {
  const group = container.querySelector(`[data-graph-edge="${key}"]`);
  const line = group?.querySelectorAll('path')[1];
  // 不用 instanceof SVGPathElement：jsdom 里没有这个全局构造函数。
  if (line === undefined) throw new Error(`没有找到边 ${key} 的线`);
  return line;
}

afterEach(cleanup);

describe('依赖图视图', () => {
  it('每个任务画一个节点，节点上带工期与三个时间数字', () => {
    const { container } = renderGraph();
    expect(container.querySelectorAll('[data-graph-node]')).toHaveLength(3);

    const card = graphNode(container, 't1');
    expect(within(card).getByText('梳理旧登录流程')).toBeTruthy();
    expect(within(card).getByText('工期 1 天')).toBeTruthy();
    for (const label of ['最早开始', '最晚开始', '松弛']) {
      expect(within(card).getByText(label)).toBeTruthy();
    }
  });

  it('关键节点用强调色底与竖条，未估工期的节点带「未估」标', () => {
    const { container } = renderGraph();
    expect(graphNode(container, 't1').className).toContain('bg-accent-weak');
    expect(graphNode(container, 't2').className).toContain('bg-surface');
    // 未估工期：虚线边框 + 节点上的「未估」标。
    const unestimated = graphNode(container, 't3');
    expect(unestimated.className).toContain('border-dashed');
    expect(within(unestimated).getByText('未估')).toBeTruthy();
    // 关键节点的松弛是 0：显示「0 分」而不是「瞬时」，而且松弛那一格用强调色。
    const zeros = within(graphNode(container, 't1')).getAllByText('0 分');
    expect(zeros).toHaveLength(3);
    expect(zeros[2]?.className).toContain('text-accent');
  });

  it('关键边用强调色，非关键边用边框色', () => {
    const { container } = renderGraph();
    expect(edgeLine(container, 't1->t3').getAttribute('stroke')).toBe('var(--color-accent)');
    expect(edgeLine(container, 't2->t3').getAttribute('stroke')).toBe('var(--color-line-strong)');
  });

  it('点节点：选中并显示详情，点「进入看板」把任务 id 交回上层', () => {
    const { container, props } = renderGraph();
    fireEvent.click(graphNode(container, 't1'));

    expect(graphNode(container, 't1').getAttribute('aria-pressed')).toBe('true');
    const detail = screen.getByLabelText('梳理旧登录流程 的排期');
    // 每一行都要「标签 → 值」配对断言。只查标签存在的话，把「最早结束」写成 earliestStart
    // 也不会红（审阅的变异检验抓到过这个缺口）。
    const rows = [...detail.querySelectorAll('dt')].map((label) => [
      label.textContent,
      label.nextElementSibling?.textContent,
    ]);
    expect(rows).toEqual([
      ['最早开始', '0 分'],
      ['最早结束', '1 天'],
      ['最晚开始', '0 分'],
      ['最晚结束', '3 天'],
      ['松弛时间', '0 分'],
    ]);
    // 列名来自看板列字典，详情卡里显示的是「进行中」而不是 columnId。
    expect(within(detail).getByText(/进行中/)).toBeTruthy();

    fireEvent.click(within(detail).getByRole('button', { name: '进入看板' }));
    expect(props.onOpenTask).toHaveBeenCalledWith('t1');
  });

  it('选中一个任务：它自己带外环，与它无关的边变淡，再点一次取消选中', () => {
    const { container } = renderGraph();
    fireEvent.click(graphNode(container, 't1'));
    expect(graphNode(container, 't1').className).toContain('ring-2');
    // t2→t3 与选中项无关，要变淡；t1→t3 有关，保持满色。
    expect(container.querySelector('[data-graph-edge="t1->t3"]')?.getAttribute('opacity')).toBe('1');
    expect(container.querySelector('[data-graph-edge="t2->t3"]')?.getAttribute('opacity')).toBe('0.4');

    fireEvent.click(graphNode(container, 't1'));
    expect(graphNode(container, 't1').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByLabelText('梳理旧登录流程 的排期')).toBeNull();
  });

  it('平移的 3px 手抖阈值：几乎不动的按下-松手仍然算点击空白处', () => {
    const { container } = renderGraph();
    fireEvent.click(graphNode(container, 't1'));
    expect(screen.queryByLabelText('梳理旧登录流程 的排期')).not.toBeNull();

    // 移动 2px 不该被当成拖拽，否则「点空白处取消选中」就点不掉了。
    fireEvent.pointerDown(stage(container), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(document, { clientX: 102, clientY: 100 });
    fireEvent.pointerUp(document, { clientX: 102, clientY: 100 });

    expect(screen.queryByLabelText('梳理旧登录流程 的排期')).toBeNull();
  });

  it('点画布空白处取消选中，Esc 也能收起详情', () => {
    const { container } = renderGraph();
    fireEvent.click(graphNode(container, 't1'));
    expect(screen.queryByLabelText('梳理旧登录流程 的排期')).not.toBeNull();

    // 按下就松手（没有移动）算一次点击空白处。
    fireEvent.pointerDown(stage(container), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(document, { clientX: 10, clientY: 10 });
    expect(screen.queryByLabelText('梳理旧登录流程 的排期')).toBeNull();

    fireEvent.click(graphNode(container, 't1'));
    fireEvent.keyDown(graphNode(container, 't1'), { key: 'Escape' });
    expect(screen.queryByLabelText('梳理旧登录流程 的排期')).toBeNull();
  });

  it('焦点停在没选中的节点上按 Escape：什么都不选，而不是把它选中', () => {
    const { container } = renderGraph();
    fireEvent.keyDown(graphNode(container, 't1'), { key: 'Escape' });
    expect(graphNode(container, 't1').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByLabelText('梳理旧登录流程 的排期')).toBeNull();
  });

  it('悬停一个节点：它和直接邻居保持满色，其余降到 40%', () => {
    const { container } = renderGraph();
    fireEvent.mouseEnter(graphNode(container, 't1'));
    expect(graphNode(container, 't1').className).not.toContain('opacity-40');
    expect(graphNode(container, 't3').className).not.toContain('opacity-40');
    // t2 与 t1 之间没有边，要从「t3 的另一个前置」里被排除掉。
    expect(graphNode(container, 't2').className).toContain('opacity-40');
  });

  it('缩放按钮改缩放比，适应窗口在量不到尺寸时回到 100%', () => {
    renderGraph();
    expect(screen.getByText('100%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByText('120%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '适应窗口' }));
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('关着「显示已归档」时不画归档节点与连着它的边，打开后一起出现', () => {
    const hidden = renderGraph({ showArchived: false });
    expect(hidden.container.querySelector('[data-graph-node="t9"]')).toBeNull();
    expect(hidden.container.querySelector('[data-graph-edge="t9->t2"]')).toBeNull();
    hidden.unmount();

    const shown = renderGraph({ showArchived: true });
    const archived = graphNode(shown.container, 't9');
    expect(within(archived).getByText('已归档')).toBeTruthy();
    expect(shown.container.querySelector('[data-graph-edge="t9->t2"]')).not.toBeNull();
  });

  it('藏了归档任务时，详情卡说明时间参数仍然包含它们', () => {
    const hidden = renderGraph({ showArchived: false });
    fireEvent.click(graphNode(hidden.container, 't1'));
    expect(within(screen.getByLabelText('梳理旧登录流程 的排期')).getByText(/包含已归档任务/)).toBeTruthy();
    hidden.unmount();

    // 没藏东西时不出现：那种场合这句话只是噪音。
    const shown = renderGraph({ showArchived: true });
    fireEvent.click(graphNode(shown.container, 't1'));
    expect(within(screen.getByLabelText('梳理旧登录流程 的排期')).queryByText(/包含已归档任务/)).toBeNull();
  });

  it('切「显示已归档」把正在 hover 的归档节点藏起来后，不要留下一整片变淡', () => {
    // 复现审阅那条：节点被卸载不会触发 mouseleave，残留的 hover id 会让所有节点停在 40%。
    const { container, rerender } = render(<DependencyGraph {...graphProps({ showArchived: true })} />);
    fireEvent.mouseEnter(graphNode(container, 't9'));
    expect(graphNode(container, 't1').className).toContain('opacity-40');

    rerender(<DependencyGraph {...graphProps({ showArchived: false })} />);
    expect(graphNode(container, 't1').className).not.toContain('opacity-40');
  });

  it('这一层没有任务时给一句空状态，而不是一张白图', () => {
    renderGraph({ state: { status: 'ready', data: { ...SCHEDULE, nodes: [], edges: [] } } });
    expect(screen.getByText(/这一层还没有任务/)).toBeTruthy();
  });

  it('加载中与失败态都保留视图切换条，用户能切回看板', () => {
    const loading = renderGraph({ state: { status: 'loading' } });
    expect(screen.getByText('加载中…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '看板' }));
    expect(loading.props.onViewChange).toHaveBeenCalledWith('board');
    loading.unmount();

    const failed = renderGraph({ state: { status: 'failed', message: '任务不存在' } });
    expect(screen.getByText('任务不存在')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(failed.props.onRetry).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '看板' })).toBeTruthy();
  });
});
