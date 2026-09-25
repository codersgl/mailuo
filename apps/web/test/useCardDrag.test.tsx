import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCardDrag } from '../src/hooks/useCardDrag';
import type { DropSlot } from '../src/domain/board';
import type { BoardTask } from '../src/api/types';

/**
 * 拖拽 hook 的指针语义。真实鼠标行为（克隆卡片、插入线、落库）在浏览器里另有验收，
 * 这里钉住只有代码本身能保证的部分：阈值、点击与拖拽的分界、Esc 取消、落点变化的去重。
 */

function task(): BoardTask {
  return {
    id: 't1',
    parentId: null,
    columnId: 'todo',
    title: '写测试',
    description: '',
    durationMinutes: null,
    spentMinutes: 0,
    runningSince: null,
    orders: 1000,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    archivedAt: null,
    childTotal: 0,
    childDone: 0,
  };
}

/** 极简宿主组件：把 hook 的返回值摊平成可以断言的回调。 */
function Harness({
  resolveDrop,
  events,
}: {
  resolveDrop: (x: number, y: number) => DropSlot | null;
  events: Record<string, unknown[]>;
}) {
  const drag = useCardDrag({
    resolveDrop,
    onStart: (taskId) => events.start!.push(taskId),
    onPreview: (drop) => events.preview!.push(drop),
    onDrop: (drop) => events.drop!.push(drop),
    onCancel: () => events.cancel!.push(true),
  });

  return (
    <div>
      <button
        data-testid="card"
        onPointerDown={(event) => drag.begin(task(), event)}
        onClick={() => events.open!.push(drag.canOpen())}
      >
        写测试
      </button>
      <span data-testid="dragging">{drag.draggingTaskId ?? ''}</span>
      <span data-testid="pressed">{String(drag.pressed)}</span>
      {/*
        预览的坐标也摊平出来：克隆卡片跟手靠的就是它每帧更新，而 DragGhost 上没有任何
        可断言的标记（审阅指出「派生状态零断言」，这里补上）。
      */}
      <span data-testid="preview">
        {drag.preview === null ? '' : `${drag.preview.clientX},${drag.preview.clientY}`}
      </span>
    </div>
  );
}

const slot: DropSlot = { columnId: 'doing', beforeTaskId: null };

/**
 * 默认 resolver 每帧返回一个新的落点对象，与真实的 `resolveDropSlot` 一致。
 * 如果所有调用都返回同一个对象引用，「落点没变就不通知」这条规则靠引用比较也能过，
 * 去掉按字段比较的去重实现同样全绿——那是一条抓不住回归的假通过用例（变异检验发现）。
 */
function setup(resolveDrop: (x: number, y: number) => DropSlot | null = () => ({ ...slot })) {
  const events: Record<string, unknown[]> = {
    start: [],
    preview: [],
    drop: [],
    cancel: [],
    open: [],
  };
  const { unmount } = render(<Harness resolveDrop={resolveDrop} events={events} />);
  return { events, card: screen.getByTestId('card'), unmount };
}

function pointerDown(card: HTMLElement) {
  fireEvent.pointerDown(card, { button: 0, clientX: 100, clientY: 100 });
}

afterEach(() => {
  // 这个文件里每个用例都重新 render 一次，必须显式清掉上一个用例的 DOM，否则 testid 会重复。
  cleanup();
  vi.restoreAllMocks();
});

describe('useCardDrag', () => {
  it('位移在阈值内：不算拖拽，仍然是一次点击', () => {
    const { events, card } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 102, clientY: 101 });
    fireEvent.pointerUp(document, { clientX: 102, clientY: 101 });
    fireEvent.click(card);

    expect(events.start).toEqual([]);
    expect(events.preview).toEqual([]);
    expect(events.drop).toEqual([]);
    expect(events.open).toEqual([true]);
  });

  it('超过阈值才算拖拽：onStart 一次，落点变化才通知，松手落定', () => {
    const { events, card } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 120, clientY: 100 });

    expect(events.start).toEqual(['t1']);
    expect(events.preview).toEqual([slot]);

    // 同一个落点再移动几次：不该重复通知，否则每一帧都会触发一次重排。
    fireEvent.pointerMove(document, { clientX: 125, clientY: 105 });
    fireEvent.pointerMove(document, { clientX: 130, clientY: 108 });
    expect(events.preview).toHaveLength(1);

    fireEvent.pointerUp(document, { clientX: 130, clientY: 108 });
    expect(events.drop).toEqual([slot]);
  });

  it('拖拽中的 pointerup 不会让随后的 click 进入子看板', async () => {
    const { events, card } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    fireEvent.pointerUp(document, { clientX: 130, clientY: 100 });
    // **必须等一个真实的任务边界**：浏览器的顺序是 pointerup → 微任务 → click，
    // 同一个 JS 任务里连着 fireEvent 会把微任务挤到 click 之后，于是「用微任务清标记」
    // 那种错误实现也能通过（审阅发现的假通过用例）。
    await act(async () => {});
    fireEvent.click(card);

    expect(events.drop).toHaveLength(1);
    expect(events.open).toEqual([false]);
  });

  it('拖拽结束后过一段时间（超过抑制窗口）的点击仍然有效', async () => {
    const { events, card } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    fireEvent.pointerUp(document, { clientX: 130, clientY: 100 });

    // 抑制窗口是 300ms，这里等到它过期。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    fireEvent.click(card);

    expect(events.open).toEqual([true]);
  });

  it('拖完马上再按下：这一次按下的点击不被上一次的抑制窗口吞掉', () => {
    const { events, card } = setup();

    // 第一次真的拖了一次，留下 300ms 的抑制窗口。
    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    fireEvent.pointerUp(document, { clientX: 130, clientY: 100 });

    // 窗口还没过期就再按一次（位移在阈值内，是一次点击）。begin() 必须把窗口清零——
    // 卡片那份原来漏了这一行，拖完想马上点开另一张卡片会被 canOpen 吞掉（审计报告 D1）。
    pointerDown(card);
    fireEvent.pointerUp(document, { clientX: 100, clientY: 100 });
    fireEvent.click(card);

    expect(events.open).toEqual([true]);
  });

  it('拖到一半卸载（换一层看板会让 BoardPage 重挂）走 onCancel', () => {
    const { events, card, unmount } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    unmount();

    // 否则调用方以为这一次拖拽还在进行，乐观重排的撤销永远等不到（D42 记的共同行为）。
    expect(events.cancel).toEqual([true]);
  });

  /**
   * 下面四条盯的是从通用 hook 派生出来的状态（拖动中的任务 id、克隆卡片的预览、落点去重）。
   * 重构把这些值从「hook 自己存」改成「从 active/slot 派生」，而当时的用例对它们零断言：
   * 删掉 setActive(null)、删掉 onMove、把 preview 的 active 门槛去掉，全量套件都还是绿的。
   */
  it('拖动状态与预览：阈值内为空、跨阈值出现、松手后回空', () => {
    const { card } = setup();
    const dragging = () => screen.getByTestId('dragging').textContent;
    const preview = () => screen.getByTestId('preview').textContent;

    expect(dragging()).toBe('');
    expect(preview()).toBe('');

    pointerDown(card);
    // 阈值内的位移还是一次点击，拖动状态不该亮起来。
    fireEvent.pointerMove(document, { clientX: 102, clientY: 100 });
    expect(dragging()).toBe('');
    expect(preview()).toBe('');

    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    expect(dragging()).toBe('t1');
    expect(preview()).toBe('130,100');

    // 克隆卡片跟手：坐标变了预览就要跟着变。
    fireEvent.pointerMove(document, { clientX: 140, clientY: 120 });
    expect(preview()).toBe('140,120');

    fireEvent.pointerUp(document, { clientX: 140, clientY: 120 });
    expect(dragging()).toBe('');
    expect(preview()).toBe('');
  });

  it('取消之后拖动状态与预览也回空', () => {
    const { card } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    expect(screen.getByTestId('dragging').textContent).toBe('t1');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByTestId('dragging').textContent).toBe('');
    expect(screen.getByTestId('preview').textContent).toBe('');
  });

  it('同一列里换了插入锚点要再通知一次（去重不能只看列）', () => {
    let beforeTaskId: string | null = null;
    const { events, card } = setup(() => ({ columnId: 'doing', beforeTaskId }));

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    beforeTaskId = 't2';
    fireEvent.pointerMove(document, { clientX: 131, clientY: 100 });

    expect(events.preview).toEqual([
      { columnId: 'doing', beforeTaskId: null },
      { columnId: 'doing', beforeTaskId: 't2' },
    ]);
  });

  it('被拒绝的按下（右键）也清掉上一次拖拽的抑制窗口', () => {
    const { events, card } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    fireEvent.pointerUp(document, { clientX: 130, clientY: 100 });

    // 窗口内先右键按一下（不进入拖拽候选）：它同样说明「上一次拖拽的那次尾巴 click 不会再来」，
    // 窗口留着只会误吞这一次按下之后的正常点击。
    fireEvent.pointerDown(card, { button: 2, clientX: 100, clientY: 100 });
    fireEvent.click(card);

    expect(events.open).toEqual([true]);
  });

  it('监听器只在按下期间挂在 document 上，松手后摘掉', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { card } = setup();
    const count = (spy: typeof add, type: string) =>
      spy.mock.calls.filter(([eventType]) => eventType === type).length;

    pointerDown(card);
    expect(count(add, 'pointermove')).toBe(1);
    expect(count(remove, 'pointermove')).toBe(0);

    fireEvent.pointerUp(document, { clientX: 100, clientY: 100 });
    expect(count(remove, 'pointermove')).toBe(1);
  });

  it('指针被浏览器接管（pointercancel）按取消处理，不把落点提交出去', () => {
    const { events, card } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    fireEvent.pointerCancel(document);

    expect(events.cancel).toEqual([true]);
    expect(events.drop).toEqual([]);
  });

  it('Esc 取消：走 onCancel，不落定', () => {
    const { events, card } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(events.cancel).toEqual([true]);
    expect(events.drop).toEqual([]);
  });

  it('指针移到列外（落点为 null）会通知撤销，松手时不落定', () => {
    let outside = false;
    const { events, card } = setup(() => (outside ? null : slot));

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    outside = true;
    fireEvent.pointerMove(document, { clientX: 400, clientY: 10 });

    expect(events.preview).toEqual([slot, null]);
    fireEvent.pointerUp(document, { clientX: 400, clientY: 10 });
    expect(events.drop).toEqual([null]);
  });

  it('已归档的卡片不给拖', () => {
    const archived: BoardTask = { ...task(), archivedAt: '2026-09-22T00:00:00.000Z' };
    const events: Record<string, unknown[]> = { start: [], preview: [], drop: [], cancel: [], open: [] };
    const drag = { current: null as null | ReturnType<typeof useCardDrag> };

    function ArchivedHarness() {
      const controls = useCardDrag({
        resolveDrop: () => null,
        onStart: (taskId) => events.start!.push(taskId),
        onPreview: (drop) => events.preview!.push(drop),
        onDrop: (drop) => events.drop!.push(drop),
        onCancel: () => events.cancel!.push(true),
      });
      drag.current = controls;
      return (
        <button
          data-testid="archived"
          onPointerDown={(event) => controls.begin(archived, event)}
        >
          已归档
        </button>
      );
    }

    render(<ArchivedHarness />);
    pointerDown(screen.getByTestId('archived'));
    fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });

    expect(events.start).toEqual([]);
    expect(events.preview).toEqual([]);
  });

  it('有子任务的父任务不给拖：它的列由子任务推导，后端会 400', () => {
    const parent: BoardTask = { ...task(), childTotal: 2, childDone: 1 };
    const events: Record<string, unknown[]> = { start: [], preview: [], drop: [], cancel: [], open: [] };
    const drag = { current: null as null | ReturnType<typeof useCardDrag> };

    function ParentHarness() {
      const controls = useCardDrag({
        resolveDrop: () => null,
        onStart: (taskId) => events.start!.push(taskId),
        onPreview: (drop) => events.preview!.push(drop),
        onDrop: (drop) => events.drop!.push(drop),
        onCancel: () => events.cancel!.push(true),
      });
      drag.current = controls;
      return (
        <button data-testid="parent" onPointerDown={(event) => controls.begin(parent, event)}>
          有子任务
        </button>
      );
    }

    render(<ParentHarness />);
    pointerDown(screen.getByTestId('parent'));
    fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });

    expect(events.start).toEqual([]);
    expect(events.preview).toEqual([]);
  });

  it('pressed 标记：按下期间为真，松手回到假（这一次按下没进入拖拽也一样）', () => {
    const { card } = setup();

    expect(screen.getByTestId('pressed').textContent).toBe('false');
    pointerDown(card);
    expect(screen.getByTestId('pressed').textContent).toBe('true');

    // 位移在阈值内：这是一次点击，不是拖拽。调用方靠 pressed 变回 false 来补做被推迟的刷新，
    // 所以这条路径必须也置回 false——老实现只在 draggingTaskId 由非空转空时清标记，
    // 「按下但不拖」永远清不掉（见 D51）。
    fireEvent.pointerMove(document, { clientX: 101, clientY: 100 });
    expect(screen.getByTestId('pressed').textContent).toBe('true');
    fireEvent.pointerUp(document, { clientX: 101, clientY: 100 });
    expect(screen.getByTestId('pressed').textContent).toBe('false');
  });

  it('拖拽被取消（Esc）之后 pressed 也回到假', () => {
    const { card } = setup();

    pointerDown(card);
    fireEvent.pointerMove(document, { clientX: 130, clientY: 100 });
    expect(screen.getByTestId('pressed').textContent).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('pressed').textContent).toBe('false');
  });

  it('指针被浏览器接管（pointercancel）之后 pressed 也回到假', () => {
    const { card } = setup();

    pointerDown(card);
    expect(screen.getByTestId('pressed').textContent).toBe('true');

    fireEvent.pointerCancel(document);
    expect(screen.getByTestId('pressed').textContent).toBe('false');
  });

  it('不接受的按下（右键）不置 pressed', () => {
    const { card } = setup();

    fireEvent.pointerDown(card, { button: 2, clientX: 100, clientY: 100 });
    expect(screen.getByTestId('pressed').textContent).toBe('false');
  });

  it('非主键（右键）按下不给拖', () => {
    const { events, card } = setup();

    fireEvent.pointerDown(card, { button: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });

    expect(events.start).toEqual([]);
  });
});
