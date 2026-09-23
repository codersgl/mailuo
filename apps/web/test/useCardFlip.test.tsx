import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CARD_ATTR } from '../src/hooks/useCardDrag';
import { useCardFlip } from '../src/hooks/useCardFlip';
import type { Board } from '../src/api/types';

/**
 * 让位动画的回归测试。这段代码在浏览器里出过一个很隐蔽的缺陷：拖得快时同一张卡片在一段动画
 * 没跑完时就开始下一段，若起点是从 DOM 量出来的「动画中途位置」，误差会每帧翻倍，卡片最终被
 * 送到屏幕外（实测 622px → 10353px）。所以这里钉住三条不变量：
 * 1. 量位置之前必须先取消上一轮的动画；
 * 2. 换过列的卡片不做动画；
 * 3. 位置没变的卡片不做动画。
 *
 * jsdom 没有真实的 Web Animations API，也没有布局，所以这里用假的 rect 与假的 animate 来测
 * 「调用了什么顺序」，真实手感仍由浏览器验收。
 */

interface FakeCard {
  id: string;
  columnId: string;
  top: number;
  el: HTMLElement;
}

/** 造一个带卡片与列的容器，并接管 element 上的 getBoundingClientRect 与 animate。 */
function setup(cards: Array<{ id: string; columnId: string; top: number }>) {
  const container = document.createElement('div');
  const calls: string[] = [];
  const byId = new Map<string, FakeCard>();

  for (const spec of cards) {
    const column = document.createElement('div');
    column.setAttribute('data-column-id', spec.columnId);
    const card = document.createElement('div');
    card.setAttribute(CARD_ATTR, spec.id);
    card.getBoundingClientRect = () => ({ top: spec.top, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
    card.animate = ((_frames: unknown, _options: unknown) => {
      calls.push(`animate ${spec.id}`);
      return { cancel: () => calls.push(`cancel ${spec.id}`) } as unknown as Animation;
    }) as HTMLElement['animate'];
    column.appendChild(card);
    container.appendChild(column);
    byId.set(spec.id, { id: spec.id, columnId: spec.columnId, top: spec.top, el: card });
  }

  // 容器级：getAnimations 返回上一轮留下的动画，cancel 要记在它们身上。
  const pending: Animation[] = [];
  (container as unknown as { getAnimations: () => Animation[] }).getAnimations = () => {
    calls.push('getAnimations');
    return pending;
  };
  const existing = { cancel: () => calls.push('cancel-pending') } as unknown as Animation;
  pending.push(existing);

  return { container, calls, byId };
}

/** 渲染一个只挂着容器的组件，让 hook 在真实 React 生命周期里跑。 */
function Host({ container, enabled, board }: { container: HTMLElement; enabled: boolean; board: Board }) {
  const ref = { current: container } as React.RefObject<HTMLElement | null>;
  useCardFlip(ref, enabled, board);
  return null;
}

const board = (): Board => ({ parentId: null, columns: [] });

afterEach(cleanup);

describe('useCardFlip', () => {
  it('量位置之前先取消上一轮的动画（否则量到的是动画中途的位置）', () => {
    const { container, calls } = setup([{ id: 'a', columnId: 'todo', top: 100 }]);

    // 第一轮：记录初始位置，没有旧动画。
    const { rerender } = render(<Host container={container} enabled board={board()} />);
    calls.length = 0;

    // 第二轮：卡片位置变了，应当先 cancel 再 animate。
    container.querySelector<HTMLElement>(`[${CARD_ATTR}="a"]`)!.getBoundingClientRect = () =>
      ({ top: 150, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
    rerender(<Host container={container} enabled board={board()} />);

    expect(calls[0]).toBe('getAnimations');
    expect(calls).toContain('animate a');
    expect(calls.indexOf('getAnimations')).toBeLessThan(calls.indexOf('animate a'));
  });

  it('位置没变就不做动画', () => {
    const { container, calls } = setup([{ id: 'a', columnId: 'todo', top: 100 }]);
    const { rerender } = render(<Host container={container} enabled board={board()} />);
    calls.length = 0;

    rerender(<Host container={container} enabled board={board()} />);

    expect(calls).not.toContain('animate a');
  });

  it('换过列的卡片不做动画（跨列时两边布局位置可能差上千像素）', () => {
    const { container, calls, byId } = setup([{ id: 'a', columnId: 'todo', top: 100 }]);
    const { rerender } = render(<Host container={container} enabled board={board()} />);
    calls.length = 0;

    // 把卡片挪到另一列，并给它一个完全不同的位置。
    const card = byId.get('a')!;
    card.el.closest = () => {
      const col = document.createElement('div');
      col.setAttribute('data-column-id', 'done');
      return col;
    };
    card.el.getBoundingClientRect = () =>
      ({ top: 900, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
    rerender(<Host container={container} enabled board={board()} />);

    expect(calls).not.toContain('animate a');
  });

  it('没有拖拽在跑时不做动画，并把快照清掉', () => {
    const { container, calls } = setup([{ id: 'a', columnId: 'todo', top: 100 }]);
    const { rerender } = render(<Host container={container} enabled={false} board={board()} />);
    calls.length = 0;

    rerender(<Host container={container} enabled={false} board={board()} />);

    expect(calls).not.toContain('animate a');
    expect(calls).not.toContain('getAnimations');
  });
});
