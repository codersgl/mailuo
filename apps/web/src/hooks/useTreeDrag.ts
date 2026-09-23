import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TreeTask } from '../api/types';
import { resolveTreeDrop } from '../lib/tree';
import type { TreeDrop } from '../lib/tree';
import { usePointerDrag } from './usePointerDrag';

/**
 * 任务树的拖动：只能改父级，不能在树里排序（规范「界面行为」）。
 *
 * 阈值、抑制窗口、Esc / pointercancel、拖到一半被卸载时的取消这些指针语义都在
 * hooks/usePointerDrag 里，与卡片拖拽共用；这个 hook 只留树特有的两件事：
 * - 落点是「挂到某个节点下」或「与它同级（挂到它的父级下）」，不是列里的下标；
 * - 拒绝拖到自己或自己的后代下（会成环，后端也会 400）。
 *
 * 拖动中的节点本来就是树里的一行，不需要克隆卡片，只高亮候补父级。**没有插入线**：
 * 树不支持排序，画一条「插到这一行后面」的线会让人按位置理解落点（审计报告 B8）。
 * 落点在根层时没有行可高亮，那种提示在 Sidebar 顶部的落点提示里。
 */

/**
 * 树拖动的落点提示。`drop` 为 null 表示指针不在任何一行上（或者那里不能放），界面上什么都不画。
 * 行高亮与树顶提示都从 `drop` 推出来，所以这里不再单独记「悬停在那一行」。
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

/** 树行上的标记，命中测试靠它。 */
export const TREE_ROW_ATTR = 'data-tree-row';

/**
 * @param tasks 当前树里的全部任务，用来判断「不能拖到自己的后代下」。
 * @param onStart 拖拽真正开始时调用一次，调用方在这里拍下树数据快照。
 * @param onDrop 松手时调用。落点为空表示指针不在任何一行上（或者那里不能放），什么都不做。
 * @param onCancel 取消（Esc / pointercancel / 拖到一半被卸载）时调用。
 */
export function useTreeDrag(options: {
  tasks: TreeTask[];
  onStart: (taskId: string) => void;
  onDrop: (taskId: string, drop: TreeDrop | null) => void;
  onCancel: () => void;
}): TreeDragControls {
  // 命中测试要用最新的树：拖拽期间树不会变，但闭包必须能读到当前这一份。
  const tasksRef = useRef(options.tasks);
  tasksRef.current = options.tasks;

  /**
   * 把指针位置换算成落点。行的上半区 = 成为它的子节点，下半区 = 与它同级（挂到它的父级下；
   * 目标是顶层节点时新父级就是根看板）。指针落在树外时返回「什么都不放」。
   */
  function resolveSlot(clientX: number, clientY: number, taskId: string): TreeDrop | null {
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
    return resolveTreeDrop(tasksRef.current, taskId, { id: overId, lowerHalf });
  }

  const drag = usePointerDrag<string, TreeDrop>({
    resolveSlot,
    onStart: (taskId) => options.onStart(taskId),
    onDrop: (drop, taskId) => options.onDrop(taskId, drop),
    onCancel: () => options.onCancel(),
  });

  /**
   * state 直接从通用 hook 的状态推出来，不再自己存一份：落点变化时通用 hook 会 setSlot，
   * 本组件跟着重渲染，这里再 setState 一次只会多出一份可能过期的副本（原来就是这么写的）。
   * 树只画落点提示，不跟指针坐标，所以也不需要 onMove。
   */
  return {
    state: drag.active === null ? null : { draggingId: drag.active, drop: drag.slot },
    begin: (taskId, event) => {
      drag.begin(event, () => taskId);
    },
    canOpen: drag.canOpen,
  };
}
