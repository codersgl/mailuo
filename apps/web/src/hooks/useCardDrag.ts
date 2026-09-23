import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { BoardTask } from '../api/types';
import type { DropSlot } from '../domain/board';

/**
 * 看板列内的卡片拖拽。实现路线取自定版原型 B（docs/decisions.md D42）：
 * 指针事件自己实现，克隆一张卡片跟随光标，落点实时反映到看板上（乐观重排）。
 *
 * 为什么不用原生 HTML5 拖放（原型 A）：幽灵图的外观由浏览器决定，拖拽期间无法自定样式，
 * 也拿不到「会落到哪一格」的精确预览。代价是下面这些细节要自己管：
 * 点击与拖拽的区分、滚动时克隆卡片的位置、指针离开列时的取消。
 *
 * 这个 hook 只管指针语义与 DOM 命中，不认识看板数据：命中的落点交给调用方换算成
 * 后端要的 position（看板里可能混着不参与重排的归档卡片，见 domain/board.ts）。
 */

/**
 * 指针命中的落点，与看板数据无关，只描述「界面上哪一列的哪张卡片之前」。
 * 类型定义在 domain/board.ts：换算成后端 position 的那一步也在那里。
 */
export type { DropSlot } from '../domain/board';

/** 拖拽中给界面用的状态：克隆卡片要画在哪、画多大。 */
export interface CardDragPreview {
  task: BoardTask;
  /** 指针当前位置，视口坐标。 */
  clientX: number;
  clientY: number;
  /** 按下时指针在卡片内的偏移：克隆卡片据此对齐，手感上是「捏住卡片」而不是「卡片跳到指针上」。 */
  grabX: number;
  grabY: number;
  /** 被拖卡片的尺寸，让克隆卡片和它一样大。 */
  width: number;
  height: number;
}

export interface CardDragControls {
  /** 当前被拖的任务 id；空闲时为 null。 */
  draggingTaskId: string | null;
  preview: CardDragPreview | null;
  /**
   * 有一次按下还没结束：可能是待定的点击，也可能是正在拖。
   *
   * 调用方用它决定「写操作成功后的静默重取要不要让路」——重取回来的看板是按下之前那份，
   * 会在拖拽中途把卡片打回原位。以前调用方自己记这个状态，只在 draggingTaskId 由非空转空时清，
   * 于是「按下但不拖」（点卡片进下层、点「⋯」开菜单）那条路径永远清不掉（见 D51）。
   */
  pressed: boolean;
  /**
   * 绑到卡片主体与「⋯」按钮上的 onPointerDown。返回 true 表示这一次按下进入了拖拽候选
   * （调用方据此知道后面一定会有 onDrop / onCancel，可以放心地置上自己的状态）。
   */
  begin: (task: BoardTask, event: ReactPointerEvent<HTMLElement>) => boolean;
  /**
   * 卡片主体自己的 onClick 要先问这里。拖拽结束的那一次 pointerup 之后浏览器仍会补一个
   * click，不拦的话「拖完一张卡片」会顺手进入它的子看板。阈值内的位移不受影响，照旧是点击。
   */
  canOpen: () => boolean;
}

/** 超过这个距离才算拖拽，之内的位移仍然算点击（进入子看板）。 */
const DRAG_THRESHOLD_PX = 4;

/**
 * 拖拽结束后多久内的 click 算「拖拽的尾巴」，要吞掉。
 * 浏览器紧跟着 pointerup 派发 click，几十毫秒足够；窗口取大一点不影响正常点击——
 * begin() 会把窗口清零，也就是说下一次按下之后的点击永远不受影响。
 */
const CLICK_SUPPRESS_MS = 300;

/** 卡片与列在 DOM 上的标记，命中测试靠它们。 */
export const CARD_ATTR = 'data-task-id';
export const COLUMN_ATTR = 'data-column-id';

/**
 * 把视口坐标换算成落点。指针不在任何一列里时返回 null（松手即撤销）。
 *
 * 用 elementFromPoint + closest 而不是遍历所有列比矩形：嵌套层级（列 > 卡片列表 > 卡片）
 * 由 closest 一次走上去，指针压在哪张卡片上也不用再算一遍几何。
 * 拖拽中的克隆卡片有 pointer-events: none，所以它不会挡住命中。
 */
export function resolveDropSlot(clientX: number, clientY: number): DropSlot | null {
  // jsdom 里根本没有 document.elementFromPoint（`typeof` 是 undefined，不是「调用抛错」），
  // 真实浏览器不会有这个问题；这里退化成「不在任何列上」，让拖拽安静地不生效。
  const hit =
    typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(clientX, clientY)
      : null;
  const column = hit?.closest(`[${COLUMN_ATTR}]`);
  if (column === null || column === undefined) return null;
  const columnId = column.getAttribute(COLUMN_ATTR);
  if (columnId === null) return null;

  const cards = [...column.querySelectorAll<HTMLElement>(`[${CARD_ATTR}]`)];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    // 指针在该卡片上半区就插到它前面；下半区继续往下比。
    if (clientY < rect.top + rect.height / 2) {
      return { columnId, beforeTaskId: card.getAttribute(CARD_ATTR) };
    }
  }
  return { columnId, beforeTaskId: null };
}

/**
 * @param resolveDrop 把视口坐标换算成落点；落在所有列之外时返回 null。默认实现用
 * `resolveDropSlot` 做 DOM 命中测试，测试里可以换成假的。
 * @param onStart 指针位移刚超过阈值、拖拽真正开始时调用一次。调用方在这里抓住「按下时的看板」，
 * 用于落点换算与撤销——等到第一次 onPreview 再抓就晚了，那时看板已经改过一次。
 * @param onPreview 落点变化时调用：`slot` 非空时做乐观重排，为空时撤销预览。
 * @param onDrop 松手且落在有效位置时调用；`null` 表示松手时在列外。
 * @param onCancel 拖拽被取消（Esc / 指针取消）时调用，用来撤销预览。
 *
 * 所有回调都通过 ref 读取最新值，所以调用方不必为它们包 useCallback，
 * 拖拽也不会因为父组件重渲染（乐观重排就在重渲染）而中断。
 */
export function useCardDrag(options: {
  resolveDrop: (clientX: number, clientY: number) => DropSlot | null;
  onStart: (taskId: string) => void;
  onPreview: (slot: DropSlot | null) => void;
  onDrop: (slot: DropSlot | null) => void;
  onCancel: () => void;
}): CardDragControls {
  const callbacks = useRef(options);
  callbacks.current = options;

  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CardDragPreview | null>(null);
  /**
   * 是否有一次按下还没结束。走 state 而不是 ref：调用方要能依赖它——按下的这一段里被推迟的
   * 重取，得在它变回 false 的那一刻补上。写它的时机只有按下与松手两次，不产生额外渲染。
   */
  const [pressed, setPressed] = useState(false);

  /**
   * 一次拖拽的全部可变状态。用 ref 而不是 state：指针移动的每一帧都写它，
   * 走 state 会让每次移动都触发一轮渲染（真正需要重渲染的是落点，由父组件决定）。
   */
  const dragRef = useRef<{
    task: BoardTask;
    /** 按下的位置，用来判断是否超过阈值。 */
    startX: number;
    startY: number;
    /** 是否已经超过阈值。未超过时松手就是一次点击。 */
    active: boolean;
    grabX: number;
    grabY: number;
    width: number;
    height: number;
    slot: DropSlot | null;
  } | null>(null);

  // 监听器的装卸函数。用 ref 存：stop 与 begin 都要用，而它们的依赖数组必须保持稳定。
  const listenersRef = useRef<{ attach: () => void; detach: () => void } | null>(null);
  /**
   * 刚拖完的那一次点击要吞掉。**不能用微任务清标记**：真实浏览器的顺序是
   * pointerdown → pointermove → pointerup → 微任务 → click，微任务比 click 还早
   * （实测，见 docs/decisions.md D42 的更正），标记会在 click 之前就被清掉。
   * 改成按时间判：拖拽结束后的一个很短的窗口内的点击算拖拽的尾巴。
   */
  const suppressUntilRef = useRef(0);

  const stop = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    listenersRef.current?.detach();
    if (drag?.active === true) {
      suppressUntilRef.current = Date.now() + CLICK_SUPPRESS_MS;
    }
    setDraggingTaskId(null);
    setPreview(null);
    // 没有进入拖拽的那一次按下（就是一次点击）也从这里结束：不置回的话，调用方的
    // 「指针还按着」永远为真，之后所有写操作都不再刷新看板（见 D51）。
    setPressed(false);
    return drag;
  }, []);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (drag === null) return;

    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) {
        return;
      }
      drag.active = true;
      setDraggingTaskId(drag.task.id);
      // 先通知调用方「拖拽真的开始了」，再往下算落点：调用方要在这个时点拍下看板快照。
      callbacks.current.onStart(drag.task.id);
    }

    // 指针拖动时不要顺手选中文字。
    event.preventDefault();
    const next = callbacks.current.resolveDrop(event.clientX, event.clientY);
    const changed =
      next === null
        ? drag.slot !== null
        : drag.slot === null ||
          next.columnId !== drag.slot.columnId ||
          next.beforeTaskId !== drag.slot.beforeTaskId;
    if (changed) {
      drag.slot = next;
      callbacks.current.onPreview(next);
    }

    setPreview({
      task: drag.task,
      clientX: event.clientX,
      clientY: event.clientY,
      grabX: drag.grabX,
      grabY: drag.grabY,
      width: drag.width,
      height: drag.height,
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    const drag = stop();
    // drag.active 为 false 说明没超过阈值：这是一次点击，交给卡片自己的 onClick 处理。
    if (drag === null || !drag.active) return;
    callbacks.current.onDrop(drag.slot);
  }, [stop]);

  /**
   * 指针被浏览器接管（触摸滚动、系统手势）时走这里：按**取消**处理，不把落点提交给后端。
   * 原来接在 handlePointerUp 上，等于「中途被抢走也照落点写一次」，与文档说的不一致。
   */
  const handlePointerCancel = useCallback(() => {
    const drag = stop();
    if (drag === null || !drag.active) return;
    callbacks.current.onCancel();
  }, [stop]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const drag = dragRef.current;
      if (drag === null || !drag.active) return;
      stop();
      callbacks.current.onCancel();
    },
    [stop],
  );

  // 监听器装在 document 上：拖拽期间指针会跑到卡片之外，装在卡片上收不到。
  // 每个闭包都通过 ref 读状态，所以这三个 handler 是稳定的，可以自由装卸。
  useEffect(() => {
    const attach = () => {
      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerCancel);
      document.addEventListener('keydown', handleKeyDown);
    };
    const detach = () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerCancel);
      document.removeEventListener('keydown', handleKeyDown);
    };
    listenersRef.current = { attach, detach };
    // 换一层看板会让 BoardPage 重挂，拖到一半切走时必须摘掉监听并撤销预览。
    return () => {
      detach();
      if (dragRef.current !== null) {
        dragRef.current = null;
        callbacks.current.onCancel();
      }
    };
  }, [handlePointerMove, handlePointerUp, handlePointerCancel, handleKeyDown]);

  const begin = useCallback((task: BoardTask, event: ReactPointerEvent<HTMLElement>): boolean => {
    // 只认鼠标主键：右键和中键有自己的系统菜单与行为。
    if (event.button !== 0) return false;
    // 已归档的卡片不能改（后端对归档任务的 PATCH 一律拒绝，见 D16），干脆不给拖。
    if (task.archivedAt !== null) return false;
    if (dragRef.current !== null) return false;

    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      task,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      slot: null,
    };
    listenersRef.current?.attach();
    setPressed(true);
    return true;
  }, []);

  return {
    draggingTaskId,
    preview,
    pressed,
    begin,
    canOpen: () => {
      // 窗口过期就作废，免得一个很久之后的点击被上一次拖拽误吞。
      if (Date.now() >= suppressUntilRef.current) return true;
      suppressUntilRef.current = 0;
      return false;
    },
  };
}
