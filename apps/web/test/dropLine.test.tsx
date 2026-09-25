import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardView } from '../src/components/BoardView';
import type { Board, BoardTask } from '../src/api/types';

/**
 * 插入线的定位（审计报告 C4）。
 *
 * 插入线要量三样东西：目标列的列体、锚点卡片、网格。列 id 与任务 id 都来自数据库，所以
 * 用例把两者都造成「含引号」的形状：拼 CSS 选择器的写法会抛 `SyntaxError`，而这一抛发生在
 * layout effect 里——没有错误边界时整页白屏（这也正是 C4 的由来）。
 *
 * 两次渲染是刻意的，也是真实的顺序：先渲染看板（此时还没有拖拽），再带着拖拽状态重渲染。
 * 一次渲染里 DropLine 与网格同时挂载时，子组件的 layout effect 跑在网格 ref 挂上之前，
 * `gridRef.current` 还是 null，量不出东西——真实拖拽时网格早已挂载，所以没有这个问题。
 *
 * jsdom 不做布局（`getBoundingClientRect()` 全是 0），所以这里给目标列与网格装可辨认的替身
 * 矩形：断言量出来的宽度与偏移确实来自**目标列**，而不是碰巧取了第一列。
 */

const TARGET_COLUMN_ID = 'we"ird';
const TARGET_TASK_ID = 't"1';
/** 目标列的替身矩形。宽高都要与第一列不同，否则「恒取第一列」的错误实现也能过。 */
const TARGET_BODY_RECT = { left: 210, right: 531, top: 40, bottom: 300, width: 321, height: 260 };
const GRID_RECT = { left: 10, right: 800, top: 20, bottom: 600, width: 790, height: 580 };

function boardTask(id: string, columnId: string): BoardTask {
  return {
    id,
    parentId: null,
    columnId,
    title: '洗衣服',
    description: '',
    durationMinutes: null,
    spentMinutes: 0,
    runningSince: null,
    orders: 1000,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    archivedAt: null,
    childTotal: 0,
    childDone: 0,
  };
}

/** 目标列故意不是第一列：第一列是一张别处的卡片。 */
const board: Board = {
  parentId: null,
  columns: [
    { id: 'todo', name: '待办', orders: 1000, tasks: [boardTask('t1', 'todo')] },
    { id: TARGET_COLUMN_ID, name: '进行中', orders: 2000, tasks: [boardTask(TARGET_TASK_ID, TARGET_COLUMN_ID)] },
    { id: 'done', name: '完成', orders: 3000, tasks: [] },
  ],
};

/** 拖拽关闭时与打开时的两套 props。draggingTaskId 一律 null：非空会打开 FLIP 让位动画，
 *  而 jsdom 没有 getAnimations；插入线只认 dragPreview 非空。 */
function boardView(dragging: boolean) {
  return (
    <BoardView
      board={board}
      dragPreview={
        dragging
          ? {
              task: boardTask(TARGET_TASK_ID, TARGET_COLUMN_ID),
              clientX: 0,
              clientY: 0,
              grabX: 0,
              grabY: 0,
              width: 0,
              height: 0,
            }
          : null
      }
      dragSlot={dragging ? { columnId: TARGET_COLUMN_ID, beforeTaskId: TARGET_TASK_ID } : null}
      draggingTaskId={null}
      // 这些卡片没有子任务，汇总表用不上；空表就是「树还没取回来」那一种状态。
      subtreeTimes={new Map()}
      onOpenTask={() => {}}
      onEditTask={() => {}}
      onSetArchived={() => {}}
      onDeleteTask={() => {}}
      onDragStart={() => {}}
      create={{
        creatingColumnId: null,
        start: () => {},
        cancel: () => {},
        submit: () => Promise.resolve({ ok: false as const, message: '未使用' }),
      }}
    />
  );
}

const rectOf = (rect: Record<string, number>) => () => ({ ...rect, x: rect.left, y: rect.top, toJSON: () => rect }) as DOMRect;

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});

describe('卡片插入线', () => {
  it('含引号的列 id 与任务 id 都不会让定位抛错，且量的是目标列', () => {
    const { container, rerender } = render(boardView(false));

    // 先给目标列的列体与网格装替身矩形，再进入拖拽状态触发测量。
    const grid =
      container.querySelector<HTMLElement>('[data-column-id="todo"]')?.parentElement ?? null;
    const body = container.querySelector<HTMLElement>(
      `[data-column-id='${TARGET_COLUMN_ID}'] [data-column-body]`,
    );
    const anchor = container.querySelector<HTMLElement>(`[data-task-id='${TARGET_TASK_ID}']`);
    expect(grid).not.toBeNull();
    expect(body).not.toBeNull();
    expect(anchor).not.toBeNull();
    if (grid === null || body === null || anchor === null) return;
    grid.getBoundingClientRect = rectOf(GRID_RECT);
    body.getBoundingClientRect = rectOf(TARGET_BODY_RECT);
    anchor.getBoundingClientRect = rectOf({ left: 210, right: 531, top: 90, bottom: 160, width: 321, height: 70 });

    rerender(boardView(true));

    const line = container.querySelector<HTMLElement>('[data-drop-line]');
    expect(line).not.toBeNull();
    // 宽度来自目标列（321）而不是第一列（替身没给，是 0）；左边距是列体左边界减去网格左边界。
    expect(line?.style.width).toBe('321px');
    expect(line?.style.left).toBe('200px');
    // 有锚点卡片时贴着卡片上缘（90 - 网格 top 20 = 70），没有锚点才退到列尾。
    expect(line?.style.top).toBe('69px');
  });

  it('锚点卡片找不到时（数据过期）退到列尾，仍然画在目标列上', () => {
    const { container, rerender } = render(boardView(false));

    const grid =
      container.querySelector<HTMLElement>('[data-column-id="todo"]')?.parentElement ?? null;
    const body = container.querySelector<HTMLElement>(
      `[data-column-id='${TARGET_COLUMN_ID}'] [data-column-body]`,
    );
    if (grid === null || body === null) throw new Error('夹具缺失');
    grid.getBoundingClientRect = rectOf(GRID_RECT);
    body.getBoundingClientRect = rectOf(TARGET_BODY_RECT);

    // 拖拽状态里的锚点 id 在 DOM 里不存在。
    const view = (
      <BoardView
        board={board}
        dragPreview={{
          task: boardTask(TARGET_TASK_ID, TARGET_COLUMN_ID),
          clientX: 0,
          clientY: 0,
          grabX: 0,
          grabY: 0,
          width: 0,
          height: 0,
        }}
        dragSlot={{ columnId: TARGET_COLUMN_ID, beforeTaskId: '已经不在列表里' }}
        draggingTaskId={null}
        subtreeTimes={new Map()}
        onOpenTask={() => {}}
        onEditTask={() => {}}
        onSetArchived={() => {}}
        onDeleteTask={() => {}}
        onDragStart={() => {}}
        create={{
          creatingColumnId: null,
          start: () => {},
          cancel: () => {},
          submit: () => Promise.resolve({ ok: false as const, message: '未使用' }),
        }}
      />
    );

    rerender(view);

    const line = container.querySelector<HTMLElement>('[data-drop-line]');
    expect(line?.style.width).toBe('321px');
    // 列尾：列体下边界 300 - 网格 top 20 = 280，线自身再上移 1px。
    expect(line?.style.top).toBe('279px');
  });
});
