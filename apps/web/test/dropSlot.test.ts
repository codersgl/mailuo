import { afterEach, describe, expect, it } from 'vitest';
import { resolveDropSlot } from '../src/hooks/useCardDrag';

/**
 * 卡片落点命中测试（`resolveDropSlot`）的单元用例。
 *
 * 为什么单独测这一层：它是「拖到哪儿」的唯一判据，却一直没有任何用例——useCardDrag 的其余
 * 用例都注入一个假的 `resolveDrop`，App 层的拖拽又因为 jsdom 没有 elementFromPoint 而走
 * 「不在任何列上」的退化分支。也就是说真实的命中逻辑（closest 找列、逐张卡片比上半区）
 * 是整块未执行的代码。
 *
 * jsdom 不做布局也没有 elementFromPoint，所以这里造真实的 DOM 结构、给卡片装替身矩形，
 * 再给 document 装一个「指针压在哪」的替身。真实光标下的手感仍由浏览器验收。
 */

interface CardSpec {
  id: string;
  /** 卡片顶边（视口坐标）。 */
  top: number;
  height: number;
}

/** 造一个带 `data-column-id` 的列，并在里面放几张带替身矩形的卡片。 */
function column(columnId: string, cards: CardSpec[] = []): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-column-id', columnId);
  for (const spec of cards) {
    const card = document.createElement('div');
    card.setAttribute('data-task-id', spec.id);
    // 矩形给全：命中测试现在只用 top/height，但将来若改用 left/width 判定，缺字段会以
    // `undefined` 参与比较（恒 false）的形式「错着绿」，不如现在就按 DOMRect 的形状补齐。
    card.getBoundingClientRect = () =>
      ({
        top: spec.top,
        bottom: spec.top + spec.height,
        height: spec.height,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: spec.top,
        toJSON: () => ({}),
      }) as DOMRect;
    section.appendChild(card);
  }
  document.body.appendChild(section);
  return section;
}

/** 指定下一次命中测试「指针压在哪」。传 null 表示压在空白处。 */
function pointAt(element: Element | null) {
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () =>
    element;
}

afterEach(() => {
  // elementFromPoint 是 document 上后加的属性（jsdom 本来没有），逐条清掉，别漏给后面的用例。
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  document.body.innerHTML = '';
});

describe('resolveDropSlot', () => {
  it('jsdom 没有 elementFromPoint 时安静地退化成「不在任何列上」', () => {
    column('todo', [{ id: 'a', top: 100, height: 40 }]);

    expect(resolveDropSlot(10, 110)).toBeNull();
  });

  it('指针不在列里（空白、列外）返回 null', () => {
    column('todo', [{ id: 'a', top: 100, height: 40 }]);
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    pointAt(outside);

    expect(resolveDropSlot(10, 110)).toBeNull();
  });

  it('空列：落在列里就是列尾（beforeTaskId 为 null）', () => {
    pointAt(column('doing'));

    expect(resolveDropSlot(10, 10)).toEqual({ columnId: 'doing', beforeTaskId: null });
  });

  it('指针在某张卡片上半区：插到它前面，而不是列尾', () => {
    const section = column('doing', [
      { id: 'a', top: 100, height: 40 },
      { id: 'b', top: 200, height: 40 },
    ]);
    pointAt(section);

    // a 的中线是 120：110 在上半区。
    expect(resolveDropSlot(10, 110)).toEqual({ columnId: 'doing', beforeTaskId: 'a' });
  });

  it('指针越过第一张的中线、还在第二张上半区：插到第二张前面', () => {
    const section = column('doing', [
      { id: 'a', top: 100, height: 40 },
      { id: 'b', top: 200, height: 40 },
    ]);
    pointAt(section);

    // 150 过了 a 的中线（120），但还在 b 的中线（220）之上。
    expect(resolveDropSlot(10, 150)).toEqual({ columnId: 'doing', beforeTaskId: 'b' });
  });

  it('指针在最后一张卡片的下半区：列尾', () => {
    const section = column('doing', [
      { id: 'a', top: 100, height: 40 },
      { id: 'b', top: 200, height: 40 },
    ]);
    pointAt(section);

    // 230 过了 b 的中线（220）。
    expect(resolveDropSlot(10, 230)).toEqual({ columnId: 'doing', beforeTaskId: null });
  });

  it('命中的是卡片内部元素时，靠 closest 走回列与卡片', () => {
    const section = column('doing', [{ id: 'a', top: 100, height: 40 }]);
    const inner = document.createElement('span');
    section.querySelector('[data-task-id="a"]')!.appendChild(inner);
    pointAt(inner);

    expect(resolveDropSlot(10, 110)).toEqual({ columnId: 'doing', beforeTaskId: 'a' });
  });

  it('命中元素不在任何带 data-column-id 的祖先里时返回 null', () => {
    const plain = document.createElement('div');
    plain.appendChild(document.createElement('span'));
    document.body.appendChild(plain);
    pointAt(plain.firstElementChild);

    expect(resolveDropSlot(10, 10)).toBeNull();
  });
});
