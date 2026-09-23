import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TreeTask } from '../api/types';
import { resolveTreeDrop } from '../lib/tree';
import type { TreeDrop } from '../lib/tree';

/**
 * 任务树的拖动：只能改父级，不能在树里排序（规范「界面行为」）。
 *
 * 与列视图的卡片拖拽共用同一套指针语义（见 hooks/useCardDrag 的说明），差别有三处：
 * - 落点是「挂到某个节点下」或「排到某个节点后面」，不是列里的下标；
 * - 拒绝拖到自己或自己的后代下（会成环，后端也会 400）；
 * - 拖动中的节点本来就是树里的一行，不需要克隆卡片，只高亮候补父级 + 画一条插入线。
 */

/** 树拖动的落点提示。`drop.parentId` 为空表示这一次什么都不放。 */
/**
 * 树拖动的落点提示。`drop` 为 null 表示指针不在任何一行上（或者那里不能放），界面上什么都不画。
 * 行高亮与插入线都从 `drop` 推出来，所以这里不再单独记「悬停在那一行」。
 */
export interface TreeDragState {
  /** 正在拖的节点 id。 */
  draggingId: string;
  drop: TreeDrop | null;
}

export interface TreeDragControls {
  state: TreeDragState | null;
  /** 绑到每一行的 onPointerDown 上。 */
  begin: (taskId: string, event: ReactPointerEvent<HTMLElement>) => void;
  /**
   * 行自己的 onClick 要先问这里：拖拽结束的那一次 pointerup 之后浏览器仍会补一个 click，
   * 不拦的话「拖完一个节点」会顺手进入它的看板。阈值内的位移不受影响。
   */
  canOpen: () => boolean;
}

/** 超过这个距离才算拖拽，之内的位移仍然算点击（进入那一层看板）。 */
const DRAG_THRESHOLD_PX = 4;

/** 拖拽结束后多久内的 click 算「拖拽的尾巴」。取值理由见 useCardDrag 里的同名常量。 */
const CLICK_SUPPRESS_MS = 300;

/** 树行上的标记，命中测试靠它。 */
export const TREE_ROW_ATTR = 'data-tree-row';

/**
 * @param tasks 当前树里的全部任务，用来判断「不能拖到自己的后代下」。
 * @param onStart 拖拽真正开始时调用一次，调用方在这里拍下树数据快照。
 * @param onDrop 松手时调用。落点为空表示指针不在任何一行上（或者那里不能放），什么都不做。
 * @param onCancel 取消（Esc）时调用。
 */
export function useTreeDrag(options: {
  tasks: TreeTask[];
  onStart: (taskId: string) => void;
  onDrop: (taskId: string, drop: TreeDrop | null) => void;
  onCancel: () => void;
}): TreeDragControls {
  const callbacks = useRef(options);
  callbacks.current = options;
  // 命中测试要用最新的树：拖拽期间树不会变，但闭包必须能读到当前这一份。
  const tasksRef = useRef(options.tasks);
  tasksRef.current = options.tasks;

  const [state, setState] = useState<TreeDragState | null>(null);

  const dragRef = useRef<{
    taskId: string;
    startX: number;
    startY: number;
    active: boolean;
    drop: TreeDrop | null;
  } | null>(null);
  const listenersRef = useRef<{ attach: () => void; detach: () => void } | null>(null);
  /**
   * 刚拖完的那一次点击要吞掉。**不能用微任务清标记**：真实浏览器的顺序是
   * pointerup → 微任务 → click，微任务比 click 还早（见 docs/decisions.md D42 的更正），
   * 所以按时间给一个很短的窗口，窗口内的点击算拖拽的尾巴。
   */
  const suppressUntilRef = useRef(0);

  const stop = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    listenersRef.current?.detach();
    if (drag?.active === true) {
      suppressUntilRef.current = Date.now() + CLICK_SUPPRESS_MS;
    }
    setState(null);
    return drag;
  }, []);

  /**
   * 把指针位置换算成落点。行的上半区 = 成为它的子节点，下半区 = 排到它后面成为兄弟。
   * 指针落在树外时返回「什么都不放」。
   */
  const resolve = useCallback(
    (clientX: number, clientY: number): TreeDrop | null => {
      const drag = dragRef.current;
      if (drag === null) return null;
      // jsdom 里没有 document.elementFromPoint，退化成「不在任何一行上」（同 useCardDrag）。
      if (typeof document.elementFromPoint !== 'function') return null;

      const hit = document.elementFromPoint(clientX, clientY);
      const row = hit?.closest<HTMLElement>(`[${TREE_ROW_ATTR}]`);
      if (row === null || row === undefined) return null;
      const overId = row.getAttribute(TREE_ROW_ATTR);
      if (overId === null) return null;

      const rect = row.getBoundingClientRect();
      const lowerHalf = clientY > rect.top + rect.height / 2;
      // 行里可能嵌着子节点，指针压到子行上时 elementFromPoint 命中的是子行——这正是想要的：
      // 子行同样是候补父级，而 closest 只会返回最靠里的那一行。
      return resolveTreeDrop(tasksRef.current, drag.taskId, { id: overId, lowerHalf });
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null) return;

      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        drag.active = true;
        callbacks.current.onStart(drag.taskId);
      }

      event.preventDefault();
      const next = resolve(event.clientX, event.clientY);
      drag.drop = next;
      setState({ draggingId: drag.taskId, drop: next });
    },
    [resolve],
  );

  const handlePointerUp = useCallback(() => {
    const drag = stop();
    if (drag === null || !drag.active) return;
    callbacks.current.onDrop(drag.taskId, drag.drop);
  }, [stop]);

  /** 指针被浏览器接管（触摸滚动、系统手势）时按取消处理，不把落点提交出去。 */
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
      dragRef.current = null;
    };
  }, [handlePointerMove, handlePointerUp, handlePointerCancel, handleKeyDown]);

  const begin = useCallback((taskId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (dragRef.current !== null) return;
    // 上一次拖拽留下的抑制窗口不该影响这一次按下之后的正常点击。
    suppressUntilRef.current = 0;
    dragRef.current = {
      taskId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      drop: null,
    };
    listenersRef.current?.attach();
  }, []);

  return {
    state,
    begin,
    canOpen: () => {
      // 窗口过期就作废，免得一个很久之后的点击被上一次拖拽误吞。
      if (Date.now() >= suppressUntilRef.current) return true;
      suppressUntilRef.current = 0;
      return false;
    },
  };
}
