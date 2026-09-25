import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskCardFace } from '../src/components/TaskCardFace';
import { TreeNodeRow } from '../src/components/TreeNodeRow';
import type { TreeNode } from '../src/lib/tree';
import type { BoardTask, TreeTask } from '../src/api/types';

/**
 * 工期提醒在界面上的表现（定版原型 B）：卡片贴下沿的进度条 + 右下角小字，任务树右侧的小短条。
 * 判定的数学部分在 reminderDomain.test.ts 里测，这里只管「该画什么、画成哪一档、有没有可访问名字」。
 */

/** 固定基准时刻，所有用例从这里推，避免依赖真实时间。 */
const T0 = '2024-01-01T00:00:00.000Z';
const T0_MS = Date.parse(T0);

function boardTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 't1',
    parentId: null,
    columnId: 'doing',
    title: '重构登录',
    description: '',
    durationMinutes: 480,
    spentMinutes: 0,
    runningSince: null,
    orders: 1000,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    childTotal: 0,
    childDone: 0,
    ...overrides,
  };
}

function treeTask(overrides: Partial<TreeTask> = {}): TreeTask {
  return {
    id: 't1',
    parentId: null,
    title: '重构登录',
    columnId: 'doing',
    archivedAt: null,
    durationMinutes: 480,
    spentMinutes: 0,
    runningSince: null,
    ...overrides,
  };
}

/** 渲染卡片正面。只看标记，不需要卡片外壳的菜单与拖拽。 */
function renderFace(overrides: Partial<BoardTask> = {}, nowMs = T0_MS): HTMLElement {
  const task = boardTask(overrides);
  const { container } = render(
    <TaskCardFace task={task} archived={task.archivedAt !== null} nowMs={nowMs} />,
  );
  return container;
}

/** 渲染任务树的一行。`drag` 传 null：这些用例与拖拽无关。children 用来构造「有子任务的父任务」。 */
function renderTreeRow(
  overrides: Partial<TreeTask> = {},
  nowMs = T0_MS,
  children: TreeNode[] = [],
): HTMLElement {
  const node: TreeNode = { task: treeTask(overrides), children };
  const { container } = render(
    <TreeNodeRow
      node={node}
      selectedId={null}
      collapsedIds={[]}
      onToggle={vi.fn()}
      onOpen={vi.fn()}
      onDragStart={vi.fn()}
      drag={null}
      nowMs={nowMs}
      depth={0}
    />,
  );
  return container;
}

function bar(container: HTMLElement, fill: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-duration-bar="${fill}"]`);
}

/**
 * 「没画条」要查常量的 `data-duration-track`，不能查 `data-duration-bar`：
 * 后者的值是档位，fill 为 null 时 React 会直接省略这个属性，于是「给未估工期的任务也画了条」
 * 这种改坏反而测不出来（审阅用变异检验发现过这一点）。
 */
function anyTrack(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-duration-track]');
}

/** 进度条填充的宽度百分比，从内联样式上读。 */
function barPercent(element: HTMLElement): string {
  return (element.querySelector('i') as HTMLElement).style.width;
}

describe('卡片上的工期提醒', () => {
  it('进行中且剩余不足 10%：实心强调色条 + 「剩 48 分」小字', () => {
    // 工期 480、已用 432 → 剩 48 = 10%T，取等号算临近。
    const container = renderFace({ spentMinutes: 432, runningSince: T0 });

    const near = bar(container, 'near');
    expect(near).not.toBeNull();
    expect(barPercent(near!)).toBe('90%');
    expect((near!.querySelector('i') as HTMLElement).className).toContain('bg-accent');
    expect(near!.getAttribute('title')).toBe('工期 1 天，已用 7 小时 12 分，剩 48 分');

    const note = screen.getByText('剩 48 分');
    expect(note.className).toContain('text-accent');
    // 有可见小字时进度条只是装饰：信息已经由文字说出，不要让读屏念两遍。
    expect(near!.getAttribute('aria-hidden')).toBe('true');
    expect(near!.getAttribute('role')).toBeNull();
  });

  it('已用超过工期：danger 满格条 + 「超 3 小时」小字', () => {
    const container = renderFace({ spentMinutes: 660 });

    const over = bar(container, 'over');
    expect(over).not.toBeNull();
    expect(barPercent(over!)).toBe('100%');
    expect((over!.querySelector('i') as HTMLElement).className).toContain('bg-danger');

    expect(screen.getByText('超 3 小时').className).toContain('text-danger');
  });

  it('进行中但还没到 90%：只有弱填充的条，没有小字，条自己带可访问名字', () => {
    const container = renderFace({ spentMinutes: 240, runningSince: T0 });

    const weak = bar(container, 'weak');
    expect(weak).not.toBeNull();
    expect(barPercent(weak!)).toBe('50%');
    expect((weak!.querySelector('i') as HTMLElement).className).toContain('bg-accent-border');

    // 这一档没有可见文字，读屏只能靠条本身。
    expect(weak!.getAttribute('role')).toBe('img');
    expect(weak!.getAttribute('aria-label')).toBe('工期 1 天，已用 4 小时，剩 4 小时');
    expect(weak!.getAttribute('aria-hidden')).toBeNull();
    // 也不能顺手多出一行字。
    expect(screen.queryByText(/^剩 /)).toBeNull();
  });

  it('停在待办但已超期：照样标出来，只是没有「临近」档', () => {
    const container = renderFace({ columnId: 'todo', durationMinutes: 144, spentMinutes: 300 });

    expect(bar(container, 'over')).not.toBeNull();
    expect(screen.getByText('超 2 小时 36 分')).toBeTruthy();
  });

  it('未估工期不画条也不给小字', () => {
    const container = renderFace({ durationMinutes: null, spentMinutes: 9999 });

    expect(anyTrack(container)).toBeNull();
    expect(screen.queryByText(/^超 /)).toBeNull();
  });

  it('工期 0（瞬时任务）不提醒', () => {
    const container = renderFace({ durationMinutes: 0, spentMinutes: 10 });

    expect(anyTrack(container)).toBeNull();
  });

  it('完成列与已归档任务都不提醒，哪怕早就超期', () => {
    const done = renderFace({ columnId: 'done', spentMinutes: 9999 });
    expect(anyTrack(done)).toBeNull();

    cleanup();
    const archived = renderFace({ archivedAt: T0, spentMinutes: 9999 });
    expect(anyTrack(archived)).toBeNull();
  });

  it('有子任务的卡片只有子任务进度条，不画工期提醒条', () => {
    // 改这条用例的口径：父任务的列由子任务推导、表是停的（见 D76），它自己的工期提醒只会误导人。
    // 「两条不同的条互不顶替」在旧口径下靠这张卡片成立，现在两条根本不会同时出现。
    const container = renderFace({ spentMinutes: 240, runningSince: T0, childTotal: 2, childDone: 1 });

    expect(anyTrack(container)).toBeNull();
    // 子任务那条在 meta 行里，仍然画着 1/2 的宽度。
    expect(screen.getByText('1/2 子任务')).toBeTruthy();
    expect(container.querySelectorAll('i[style]')).toHaveLength(1);
  });

  it('时间往前走会让卡片自己从弱填充走到临近', () => {
    const container = renderFace({ spentMinutes: 0, runningSince: T0 }, T0_MS + 100 * 60_000);
    expect(bar(container, 'weak')).not.toBeNull();

    cleanup();
    const later = renderFace({ spentMinutes: 0, runningSince: T0 }, T0_MS + 432 * 60_000);
    expect(bar(later, 'near')).not.toBeNull();
    expect(screen.getByText('剩 48 分')).toBeTruthy();
  });
});

describe('任务树节点上的工期提醒', () => {
  it('临近的节点画一条小短条，数值在可访问名字里', () => {
    const container = renderTreeRow({ spentMinutes: 432, runningSince: T0 });

    const near = bar(container, 'near');
    expect(near).not.toBeNull();
    expect(barPercent(near!)).toBe('90%');
    // 树上没有小字，条是这一行唯一说「还剩多久」的地方，所以必须可读。
    expect(near!.getAttribute('role')).toBe('img');
    expect(near!.getAttribute('aria-label')).toBe('工期 1 天，已用 7 小时 12 分，剩 48 分');
  });

  it('超期的节点用危险色短条', () => {
    const container = renderTreeRow({ spentMinutes: 660 });

    const over = bar(container, 'over');
    expect(over).not.toBeNull();
    expect((over!.querySelector('i') as HTMLElement).className).toContain('bg-danger');
  });

  it('未估工期与完成列的节点都没有条', () => {
    const unestimated = renderTreeRow({ durationMinutes: null });
    expect(anyTrack(unestimated)).toBeNull();

    cleanup();
    const done = renderTreeRow({ columnId: 'done', spentMinutes: 9999 });
    expect(anyTrack(done)).toBeNull();
  });

  it('有子任务的父节点不画条，叶子节点照画', () => {
    // 子行的节点设成未估工期（不画条），并把查询范围收到父节点自己那一行上：
    // TreeNodeRow 会把子节点递归渲染在同一个容器里，不这样收窄会把子行的条算成父节点的。
    const child: TreeNode = {
      task: treeTask({ id: 'c', parentId: 'p', durationMinutes: null }),
      children: [],
    };
    const parent = renderTreeRow({ id: 'p', spentMinutes: 432, runningSince: T0 }, T0_MS, [child]);
    const parentRow = parent.querySelector<HTMLElement>('[data-tree-row="p"]')!;
    expect(parentRow.querySelector('[data-duration-track]')).toBeNull();

    cleanup();
    const leaf = renderTreeRow({ id: 'leaf', spentMinutes: 432, runningSince: T0 });
    expect(anyTrack(leaf)).not.toBeNull();
  });
});

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});
