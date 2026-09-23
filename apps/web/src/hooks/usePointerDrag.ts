import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * 指针拖拽的公共脚手架：阈值、点击与拖拽的分界、落点换算与去重、document 上的四个监听器、
 * Esc 与 pointercancel 的取消语义、拖到一半被卸载时的兜底取消。
 *
 * 为什么抽出来：列内卡片（useCardDrag）与任务树（useTreeDrag）原本各写一份，指针这部分几乎
 * 逐字重复。重复本身是维护成本，更要紧的是两处已经分叉——卡片那份的 `begin()` 忘了清抑制
 * 窗口，树那份卸载时不走 `onCancel`，而 D42 的文档把两件事都写成了共同行为（见审计报告 D1）。
 * 抽到一处后，两个 hook 只剩各自的命中测试与落点语义，这类分叉不会再出现。
 *
 * 泛型参数：`T` 是调用方的载荷（卡片是「任务 + 按下时量到的矩形」，树是任务 id），
 * `S` 是落点（卡片是列内位置，树是新父级）。这个 hook 不认识任何看板或树的数据结构。
 */

/** 超过这个距离才算拖拽，之内的位移仍然算点击（进入下层看板）。两组拖拽共用一个手感。 */
const DRAG_THRESHOLD_PX = 4;

/**
 * 拖拽结束后多久内的 click 算「拖拽的尾巴」，要吞掉。
 * 浏览器紧跟着 pointerup 派发 click，几十毫秒足够；窗口取大一点不影响正常点击——
 * `begin()` 会把窗口清零，下一次按下之后的点击永远不受影响。
 */
const CLICK_SUPPRESS_MS = 300;

export interface PointerDragOptions<T, S> {
  /** 把视口坐标换算成落点；返回 null 表示指针不在有效落点上。拖动期间每帧调用。 */
  resolveSlot: (clientX: number, clientY: number, payload: T) => S | null;
  /** 两个落点算不算同一个；相同就不重复通知 `onSlotChange`。默认 `Object.is`。 */
  isSameSlot?: (a: S, b: S) => boolean;
  /** 这一次按下能不能进入拖拽候选（例如已归档的卡片不给拖）。默认允许。 */
  canBegin?: (payload: T) => boolean;
  /** 位移刚超过阈值、拖拽真正开始时调用一次。调用方在这里拍数据快照。 */
  onStart: (payload: T) => void;
  /** 落点变化时调用。 */
  onSlotChange?: (slot: S | null, payload: T) => void;
  /** 拖拽期间每一次指针移动都调用（落点没变也调）：克隆卡片跟着指针走靠它。 */
  onMove?: (event: PointerEvent, slot: S | null, payload: T) => void;
  /** 松手时调用；`slot` 为 null 表示指针不在有效落点上。 */
  onDrop: (slot: S | null, payload: T) => void;
  /**
   * 取消时调用：Esc、pointercancel，以及「按下还没结束就被卸载」。
   * 按钮松开不算取消——那是 onDrop 或一次点击。被拒绝的按下（右键等）不会调用任何回调。
   */
  onCancel: (payload: T) => void;
}

export interface PointerDragControls<T, S> {
  /** 正在拖（已超过阈值）的载荷；空闲或还没到阈值时为 null。 */
  active: T | null;
  /** 当前落点；没在拖或指针不在有效落点上时为 null。 */
  slot: S | null;
  /**
   * 有一次按下还没结束：可能是待定的点击，也可能是正在拖。
   * 调用方用它决定「写操作成功后的静默重取要不要让路」（见 D51）。
   */
  pressed: boolean;
  /**
   * 绑到可拖元素上的 onPointerDown。`create` 在这一次按下被接受（主键、没有拖拽在跑）之后才
   * 调用，右键与重复按下不会白量矩形；`canBegin` 排在 `create` 之后是因为它要看的正是载荷本身
   * （例如「这张卡片已归档」），代价是那一种情况仍会量一次矩形。
   * 返回 true 表示这一次按下进入了拖拽候选。
   */
  begin: (event: ReactPointerEvent<HTMLElement>, create: () => T) => boolean;
  /**
   * 元素自己的 onClick 要先问这里：拖拽尾巴的那一次 click 返回 false，其余为 true。
   */
  canOpen: () => boolean;
}

export function usePointerDrag<T, S>(options: PointerDragOptions<T, S>): PointerDragControls<T, S> {
  // 回调都通过 ref 读取最新值：调用方不必为它们包 useCallback，拖拽也不会因为父组件重渲染
  // （卡片拖拽的乐观重排就在重渲染）而中断或重新装监听器。
  const callbacks = useRef(options);
  callbacks.current = options;

  const [active, setActive] = useState<T | null>(null);
  const [slot, setSlot] = useState<S | null>(null);
  const [pressed, setPressed] = useState(false);

  /**
   * 一次拖拽的全部可变状态。用 ref 而不是 state：指针移动的每一帧都要写它，
   * 走 state 会让每一次移动都触发一轮渲染。真正需要跟着每帧重渲染的东西由调用方决定
   * ——卡片要更新克隆卡片的位置（onMove），树只在落点变化时改高亮（onSlotChange）。
   */
  const dragRef = useRef<{
    payload: T;
    /** 按下的位置，用来判断是否超过阈值。 */
    startX: number;
    startY: number;
    /** 是否已经超过阈值。未超过时松手就是一次点击。 */
    active: boolean;
    slot: S | null;
  } | null>(null);

  // 监听器的装卸函数。用 ref 存：stop 与 begin 都要用，而它们的依赖数组必须保持稳定。
  const listenersRef = useRef<{ attach: () => void; detach: () => void } | null>(null);

  /**
   * 刚拖完的那一次点击要吞掉。**不能用微任务清标记**：真实浏览器的顺序是
   * pointerdown → pointermove → pointerup → 微任务 → click，微任务比 click 还早
   * （实测，见 docs/decisions.md D42），标记会在 click 之前就被清掉。
   * 改成按时间判：拖拽结束后的一个很短的窗口内的点击算拖拽的尾巴。
   */
  const suppressUntilRef = useRef(0);

  /**
   * 结束一次按下：摘监听、按需开启抑制窗口、清状态，返回按下时的记录。
   * 调用方据此判断这一次是落定、是取消，还是「根本没超过阈值的一次点击」。
   */
  const stop = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    listenersRef.current?.detach();
    if (drag?.active === true) {
      suppressUntilRef.current = Date.now() + CLICK_SUPPRESS_MS;
    }
    setActive(null);
    setSlot(null);
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
      setActive(drag.payload);
      // 先通知调用方「拖拽真的开始了」，再往下算落点：调用方要在这个时点拍快照，
      // 等到第一次 onSlotChange 再拍就晚了，那时数据已经改过一次。
      callbacks.current.onStart(drag.payload);
    }

    // 指针拖动时不要顺手选中文字。
    event.preventDefault();
    const next = callbacks.current.resolveSlot(event.clientX, event.clientY, drag.payload);
    const same = callbacks.current.isSameSlot ?? Object.is;
    const changed = next === null ? drag.slot !== null : drag.slot === null || !same(drag.slot, next);
    if (changed) {
      drag.slot = next;
      setSlot(next);
      callbacks.current.onSlotChange?.(next, drag.payload);
    }
    callbacks.current.onMove?.(event, drag.slot, drag.payload);
  }, []);

  const handlePointerUp = useCallback(() => {
    const drag = stop();
    // active 为 false 说明没超过阈值：这是一次点击，交给元素自己的 onClick 处理。
    if (drag === null || !drag.active) return;
    callbacks.current.onDrop(drag.slot, drag.payload);
  }, [stop]);

  /**
   * 指针被浏览器接管（触摸滚动、系统手势）时走这里：按**取消**处理，不把落点提交出去。
   * 原来接在 handlePointerUp 上，等于「中途被抢走也照落点写一次」，与文档说的不一致。
   */
  const handlePointerCancel = useCallback(() => {
    const drag = stop();
    if (drag === null || !drag.active) return;
    callbacks.current.onCancel(drag.payload);
  }, [stop]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const drag = dragRef.current;
      if (drag === null || !drag.active) return;
      stop();
      callbacks.current.onCancel(drag.payload);
    },
    [stop],
  );

  // 监听器装在 document 上：拖拽期间指针会跑到元素之外，装在元素上收不到。
  // 每个闭包都通过 ref 读状态，所以这四个 handler 是稳定的，effect 只跑挂载与卸载两次。
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
    return () => {
      detach();
      // 按下还没结束就被卸载（换个看板、把树面板收起来）必须走 onCancel，否则调用方以为这一次
      // 还按着，预览的撤销永远等不到。这里包含「还没跨阈值的那一次按下」：那种情况 onStart 没被
      // 调用过、没有乐观状态可撤，但「这次按下结束了」这个信号仍然要给出去（卡片旧实现也是
      // 无条件取消）。只清 ref、不写 state——卸载后 setState 无意义。
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag !== null) callbacks.current.onCancel(drag.payload);
    };
  }, [handlePointerMove, handlePointerUp, handlePointerCancel, handleKeyDown]);

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>, create: () => T): boolean => {
    /**
     * 任何一次按到可拖元素上的按下都清掉上一次拖拽留下的抑制窗口，包括随后会被拒绝的那些
     * （右键、重复按下、已归档卡片）。这句话 D42 就写在文档里，但卡片那份的 begin() 漏了这一行，
     * 于是拖完 300ms 内想点开另一张卡片会被 canOpen 吞掉（见审计报告 D1）。
     *
     * 为什么放在最前面而不是接受之后：抑制窗口要吞的是拖拽 pointerup 紧跟着的那一次 click，
     * 它只可能出现在「上一次拖拽的松手」与「下一个 pointerdown」之间；既然新的按下已经来了，
     * 那一次 click 无论如何不会再有，窗口留着只会误吞这一次按下之后的正常点击。
     */
    suppressUntilRef.current = 0;
    // 只认鼠标主键：右键和中键有自己的系统菜单与行为。
    if (event.button !== 0) return false;
    // 上一次拖拽还没结束（重复按下）时不开第二次。
    if (dragRef.current !== null) return false;

    const payload = create();
    if (callbacks.current.canBegin !== undefined && !callbacks.current.canBegin(payload)) {
      return false;
    }

    dragRef.current = {
      payload,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      slot: null,
    };
    listenersRef.current?.attach();
    setPressed(true);
    return true;
  }, []);

  const canOpen = useCallback(() => {
    // 窗口过期就作废，免得一个很久之后的点击被上一次拖拽误吞。
    if (Date.now() >= suppressUntilRef.current) return true;
    suppressUntilRef.current = 0;
    return false;
  }, []);

  return { active, slot, pressed, begin, canOpen };
}
