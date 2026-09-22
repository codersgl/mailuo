import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { Board, BoardTask, TreeTask } from '../src/api/types';

/**
 * 端到端过一遍导航：URL → 看哪一层看板 → 面包屑与文件树选中态 → 点卡片进下一层。
 * 接口全部打桩，测的是这一层接线（真实后端契约由 apps/api 的用例保证）。
 */

function boardTask(id: string, columnId: string, title: string): BoardTask {
  return {
    id,
    parentId: null,
    columnId,
    title,
    description: '',
    durationMinutes: null,
    orders: 1000,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    archivedAt: null,
    childTotal: 0,
    childDone: 0,
  };
}

/** 按列分组的看板，列固定为迁移里的三列。 */
function board(parentId: string | null, tasks: BoardTask[]): Board {
  return {
    parentId,
    columns: [
      { id: 'todo', name: '待办', orders: 1000, tasks: tasks.filter((t) => t.columnId === 'todo') },
      {
        id: 'doing',
        name: '进行中',
        orders: 2000,
        tasks: tasks.filter((t) => t.columnId === 'doing'),
      },
      { id: 'done', name: '完成', orders: 3000, tasks: tasks.filter((t) => t.columnId === 'done') },
    ],
  };
}

const treeTasks: TreeTask[] = [
  { id: 'a', parentId: null, title: '重构登录', columnId: 'doing', archivedAt: null },
  { id: 'a2', parentId: 'a', title: '前端表单改造', columnId: 'doing', archivedAt: null },
  { id: 'b', parentId: null, title: '支付对账', columnId: 'todo', archivedAt: null },
  { id: 'b1', parentId: 'b', title: '对账脚本', columnId: 'todo', archivedAt: null },
];

const routes: Record<string, unknown> = {
  '/api/board': board(null, [boardTask('b', 'todo', '支付对账')]),
  '/api/board/b': board('b', [boardTask('b1', 'todo', '对账脚本')]),
  '/api/tree': { tasks: treeTasks },
  '/api/breadcrumb/b': {
    items: [
      { id: null, title: '根看板' },
      { id: 'b', title: '支付对账' },
    ],
  },
};

function stubApi(): void {
  vi.stubGlobal('fetch', (input: string) => {
    const body = routes[String(input)];
    const status = body === undefined ? 404 : 200;
    return Promise.resolve(
      new Response(JSON.stringify(body ?? { error: '任务不存在' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
}

/** 看板区是 main；文件树在 aside 里，同名任务（面包屑、树、卡片）用 within 区分。 */
function boardArea() {
  return within(document.querySelector('main')!);
}

function breadcrumbNav() {
  return within(document.querySelector('nav[aria-label="面包屑"]')!);
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

describe('App', () => {
  it('根看板：面包屑只有一段，点卡片进子看板并换掉面包屑与看板内容', async () => {
    stubApi();
    render(<App />);

    // 根看板：面包屑只有「根看板」一段，且是当前位置。
    expect(breadcrumbNav().getByText('根看板').getAttribute('aria-current')).toBe('page');
    expect(await boardArea().findByText('支付对账')).toBeTruthy();
    // 文件树同时加载出来。
    expect(await screen.findByText('前端表单改造')).toBeTruthy();

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
    stubApi();
    window.history.replaceState(null, '', '/board/b');
    render(<App />);

    const tree = within(document.querySelector('aside')!);
    const selected = await tree.findByText('支付对账');

    expect(selected.getAttribute('aria-current')).toBe('page');
    // 根看板不是任务，所以只有子看板里才会有选中项。
    expect(tree.getByText('重构登录').getAttribute('aria-current')).toBeNull();
  });

  it('地址认不出来时给一条回根看板的路，而不是显示根看板', async () => {
    stubApi();
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
    stubApi();
    window.history.replaceState(null, '', '/board/missing');
    render(<App />);

    expect(await boardArea().findByText('任务不存在')).toBeTruthy();
    expect(boardArea().getByRole('button', { name: '重试' })).toBeTruthy();
    expect(breadcrumbNav().queryByText('根看板')).toBeNull();
  });
});
