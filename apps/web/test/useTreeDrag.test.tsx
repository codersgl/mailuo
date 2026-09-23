import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useTreeDrag } from '../src/hooks/useTreeDrag';
import type { TreeTask } from '../src/api/types';

/**
 * 任务树拖动的指针语义。与 useCardDrag 是同一套阈值与取消规则，但落点语义不同
 * （改层级而不是排序），所以单独钉住：拖到自己/后代不生效、点击与拖拽的分界、
 * pointercancel 走取消。
 */

const tasks: TreeTask[] = [
  { id: 'a', parentId: null, title: 'A', columnId: 'todo', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
  { id: 'a1', parentId: 'a', title: 'A1', columnId: 'todo', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
  { id: 'a1x', parentId: 'a1', title: 'A1X', columnId: 'todo', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
  { id: 'b', parentId: null, title: 'B', columnId: 'todo', archivedAt: null, durationMinutes: null, spentMinutes: 0, runningSince: null },
];

function Harness({ log, over }: { log: string[]; over: () => string }) {
  const drag = useTreeDrag({
    tasks,
    onStart: (id) => log.push('start ' + id),
    onDrop: (id, drop) =>
      log.push(`drop ${id} ${drop === null ? 'null' : `${drop.parentId}`}`),
    onCancel: () => log.push('cancel'),
  });
  return (
    <div>
      <button
        data-testid="row-a"
        onPointerDown={(event) => {
          drag.begin('a', event);
          log.push('begin a');
        }}
        onClick={() => log.push('open ' + drag.canOpen())}
      >
        A
      </button>
      <button
        data-testid="row-a1x"
        onPointerDown={(event) => {
          drag.begin('a1x', event);
          log.push('begin a1x');
        }}
      >
        A1X
      </button>
      <span data-testid="state">{drag.state === null ? '' : drag.state.drop?.parentId ?? 'none'}</span>
      <span data-testid="over">{over()}</span>
    </div>
  );
}

/** 行的假矩形：高 20、从 y=0 开始，所以 y < 10 算上半区、y >= 10 算下半区。 */
const ROW_HEIGHT = 20;

/** 用一个可变的「指针下是哪一行」来替掉 elementFromPoint（jsdom 里没有真布局）。 */
function setup() {
  const log: string[] = [];
  let over: string | null = null;
  (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => {
    if (over === null) return null;
    const row = {
      getAttribute: () => over,
      getBoundingClientRect: () => ({ top: 0, height: ROW_HEIGHT }),
    };
    return { closest: () => row } as unknown as Element;
  };
  render(<Harness log={log} over={() => over ?? 'none'} />);
  return {
    log,
    setOver: (id: string | null) => {
      over = id;
    },
  };
}

function drag(rowTestId: string, to: { x: number; y: number }) {
  const row = screen.getByTestId(rowTestId);
  fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(document, { clientX: to.x, clientY: to.y });
}

afterEach(() => {
  cleanup();
});

describe('useTreeDrag', () => {
  it('阈值内的位移不算拖拽，点击照常', () => {
    const { log } = setup();

    const row = screen.getByTestId('row-a');
    fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(document, { clientX: 1, clientY: 1 });
    fireEvent.pointerUp(document, { clientX: 1, clientY: 1 });
    fireEvent.click(row);

    expect(log).toEqual(['begin a', 'open true']);
  });

  it('拖到另一行上半区：落点是「成为它的子节点」', () => {
    const { log, setOver } = setup();

    setOver('b');
    drag('row-a', { x: 40, y: 5 });
    fireEvent.pointerUp(document, { clientX: 40, clientY: 5 });

    expect(log).toEqual(['begin a', 'start a', 'drop a b']);
  });

  it('拖到顶层节点的下半区：落点是根看板（它的「兄弟」只能是根层）', () => {
    const { log, setOver } = setup();

    // b 的父级是 null：下半区表达为「回到根层」（父级 null）。树不支持排序，所以没有
    // 「排在 b 后面」这种更细的位置，界面只在树顶给出「挂到根看板」这一行提示。
    setOver('b');
    drag('row-a', { x: 40, y: 15 });
    fireEvent.pointerUp(document, { clientX: 40, clientY: 15 });

    expect(log).toEqual(['begin a', 'start a', 'drop a null']);
  });

  it('拖到有父级的行下半区：落点是「与它同级，排在它后面」', () => {
    const { log, setOver } = setup();

    // a1 的父级是 a，所以 a1x（a1 的子节点）拖到 a1 的下半区 = 挂到 a 下。
    setOver('a1');
    drag('row-a1x', { x: 40, y: 15 });
    fireEvent.pointerUp(document, { clientX: 40, clientY: 15 });

    expect(log).toEqual(['begin a1x', 'start a1x', 'drop a1x a']);
  });

  it('拖到自己的后代上不算落点，松手什么都不做', () => {
    const { log, setOver } = setup();

    setOver('a1x');
    drag('row-a', { x: 40, y: 5 });
    fireEvent.pointerUp(document, { clientX: 40, clientY: 5 });

    expect(log).toEqual(['begin a', 'start a', 'drop a null']);
  });

  it('指针在树外松手：落点为空', () => {
    const { log, setOver } = setup();

    setOver(null);
    drag('row-a', { x: 400, y: 5 });
    fireEvent.pointerUp(document, { clientX: 400, clientY: 5 });

    expect(log).toEqual(['begin a', 'start a', 'drop a null']);
  });

  it('Esc 取消', () => {
    const { log, setOver } = setup();

    setOver('b');
    drag('row-a', { x: 40, y: 5 });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(log).toEqual(['begin a', 'start a', 'cancel']);
  });

  it('pointercancel 按取消处理，不提交落点', () => {
    const { log, setOver } = setup();

    setOver('b');
    drag('row-a', { x: 40, y: 5 });
    fireEvent.pointerCancel(document);

    expect(log).toEqual(['begin a', 'start a', 'cancel']);
  });

  it('拖拽之后的 click 不进入那一层看板；过一段时间后的点击仍然有效', async () => {
    const { log, setOver } = setup();

    setOver('b');
    drag('row-a', { x: 40, y: 5 });
    fireEvent.pointerUp(document, { clientX: 40, clientY: 5 });
    // 真实浏览器的顺序是 pointerup → 微任务 → click，所以必须等一个任务边界。
    await act(async () => {});
    fireEvent.click(screen.getByTestId('row-a'));

    expect(log).toEqual(['begin a', 'start a', 'drop a b', 'open false']);
  });
});
