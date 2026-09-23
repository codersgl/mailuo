import { useLayoutEffect, useRef } from 'react';
import type { Board } from '../api/types';
import { CARD_ATTR } from './useCardDrag';

/** 让位动画的时长。 */
const FLIP_MS = 120;

/**
 * 卡片让位动画（FLIP）：拖拽期间位置变了的卡片，从「上一帧看到的位置」滑到新位置，
 * 看起来就是其它卡片滑开、给拖动的卡片腾位子。
 *
 * 只在拖拽期间生效：平时新建、归档、换看板也会让卡片换位置，那些场合加动画只会显得飘。
 *
 * 用 Web Animations API，而不是「写 transform + 下一轮再放开 transition」那一套：后者不可重入。
 * 拖得快时同一张卡片会在上一段动画没跑完时就开始下一段，而那种写法必须在同一帧里写起点，
 * 起点又是从 DOM 量出来的——量到的是动画中途的位置，误差每帧翻倍。实测在第二、三列之间快速
 * 来回拖动时，同一列里其它卡片的相对位置从 622px 一路涨到 10353px（每帧翻倍），卡片被送到
 * 屏幕外，肉眼就是「卡片消失了」。WAAPI 的 `animate()` 自带起点/终点并且可以被取消：
 * 重入前先 cancel 掉旧动画，量到的是干净的布局位置，动画从「当前看到的位置」接着走，不会累积。
 *
 * 换过列的卡片仍然不做动画：跨列时 React 把节点搬到另一列的 DOM 里，两边布局位置可能相差
 * 上千像素，补一段横跨两列的动画既难看也没意义，直接出现在新位置更干净。
 */
export function useCardFlip(
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  board: Board,
) {
  const previous = useRef<Map<string, { rect: DOMRect; columnId: string }> | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;

    // 没有拖拽在跑：把记录清掉，免得下次开始拖拽时拿一份过期快照当起点。
    if (container === null || !enabled) {
      previous.current = null;
      return;
    }

    // 先取消上一轮还在跑的动画，随后的量测才是布局位置（不是动画中途的位置）。
    for (const animation of container.getAnimations({ subtree: true })) animation.cancel();
    const now = readCardRects(container);

    const before = previous.current;
    for (const card of container.querySelectorAll<HTMLElement>(`[${CARD_ATTR}]`)) {
      const id = card.getAttribute(CARD_ATTR);
      if (id === null) continue;
      const current = now.get(id);
      const old = before?.get(id);
      if (current === undefined || old === undefined) continue;
      // 换过列的卡片直接出现在新位置，不做动画（理由见上面的注释）。
      if (old.columnId !== current.columnId) continue;

      const dx = old.rect.left - current.rect.left;
      const dy = old.rect.top - current.rect.top;
      if (dx === 0 && dy === 0) continue;

      card.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: FLIP_MS, easing: 'ease' },
      );
    }

    previous.current = now;
    // board 必须在依赖里：拖拽期间每次乐观重排都会换一个 board 对象，effect 才重跑得起来。
    // 少了它，enabled 只从 false 变到 true 一次，让位动画根本不会执行（审阅发现的缺陷）。
  }, [containerRef, enabled, board]);
}

/** 每张卡片当前的位置与所在列。取消动画之后调用，量到的才是布局位置。 */
function readCardRects(
  container: HTMLElement | null,
): Map<string, { rect: DOMRect; columnId: string }> {
  const rects = new Map<string, { rect: DOMRect; columnId: string }>();
  if (container === null) return rects;
  for (const card of container.querySelectorAll<HTMLElement>(`[${CARD_ATTR}]`)) {
    const id = card.getAttribute(CARD_ATTR);
    if (id === null) continue;
    rects.set(id, {
      rect: card.getBoundingClientRect(),
      columnId: card.closest('[data-column-id]')?.getAttribute('data-column-id') ?? '',
    });
  }
  return rects;
}
