import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardView } from '../src/components/BoardView';
import type { Board } from '../src/api/types';

/**
 * 看板「列撑满、列尾可落点」这条布局不变量的替身断言。
 *
 * 为什么需要它：这个缺陷（列高只等于内容高，最后一张卡片下面的空白不属于任何列，
 * 于是拖不到列尾）从第 9 步一直躺到第 12 步才被发现，原因是它**在 jsdom 里完全测不出来**——
 * jsdom 不做布局，`document.elementFromPoint` 也不存在。真正的证据是浏览器验收，
 * 但那条只在人手跑的时候才存在。所以这里退一步，钉住让那条链路成立的两个类：
 *
 * 1. 网格必须带一个「确定高度」的工具类（当前是 h-full）：Column 的 self-stretch 要有明确的行高可撑，
 *    网格高度是内容高的话它撑不起来；
 * 2. 列必须带 self-stretch：否则即使网格有高度，列也还是内容高。
 *
 * 代价说清楚：它只能证明「这两个类还在」，证明不了「布局真的对」。谁把 h-full 删了、
 * 换成 min-h-full，这条测试不会红（那也确实仍然满足不变量）；但把高度类整条拿掉
 * （第 9 步到第 12 步之间的写法）会被拦住。
 */

const board: Board = {
  parentId: null,
  columns: [
    {
      id: 'todo',
      name: '待办',
      orders: 1000,
      tasks: [
        {
          id: 't1',
          parentId: null,
          columnId: 'todo',
          title: '洗衣服',
          description: '',
          durationMinutes: null,
          orders: 1000,
          createdAt: '2026-09-23T00:00:00.000Z',
          updatedAt: '2026-09-23T00:00:00.000Z',
          archivedAt: null,
          childTotal: 0,
          childDone: 0,
        },
      ],
    },
    { id: 'doing', name: '进行中', orders: 2000, tasks: [] },
    { id: 'done', name: '完成', orders: 3000, tasks: [] },
  ],
};

/** 网格支持的「确定高度」工具类。加新写法时把它加进来，而不是把断言放宽。 */
const DEFINITE_HEIGHT_CLASSES = ['h-full'];

function renderBoard() {
  return render(
    <BoardView
      board={board}
      dragPreview={null}
      dragSlot={null}
      draggingTaskId={null}
      onOpenTask={() => {}}
      onEditTask={() => {}}
      onSetArchived={() => {}}
      onDeleteTask={() => {}}
      onDragStart={() => {}}
      create={{
        creatingColumnId: null,
        start: () => {},
        cancel: () => {},
        // 这个测试不提交新建，给一个形状正确的空实现即可。
        submit: () => Promise.resolve({ ok: false as const, message: '未使用' }),
      }}
    />,
  );
}

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});

describe('看板布局不变量', () => {
  it('网格带确定高度类，且三列都带 self-stretch', () => {
    const { container } = renderBoard();
    const columns = [...container.querySelectorAll('[data-column-id]')];
    expect(columns).toHaveLength(3);

    // 网格是列的直接父元素：resolveDropSlot 用 elementFromPoint 命中的那块区域就是它的盒子。
    const grid = columns[0]?.parentElement;
    expect(grid).not.toBeNull();
    const gridClasses = (grid?.className ?? '').split(/\s+/);
    expect(gridClasses.some((name) => DEFINITE_HEIGHT_CLASSES.includes(name))).toBe(true);

    for (const column of columns) {
      expect(column.className).toContain('self-stretch');
      // 底部留白必须在列自己身上：放在网格上时那 28px 是父容器的 padding，
      // elementFromPoint 命中的是网格而不是列，列尾就成了死区。
      expect(column.className).toContain('pb-7');
    }
    expect(gridClasses).not.toContain('pb-7');
  });
});
