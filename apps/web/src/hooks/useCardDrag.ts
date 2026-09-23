import { useCallback, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { BoardTask } from '../api/types';
import type { DropSlot } from '../domain/board';
import { usePointerDrag } from './usePointerDrag';

/**
 * 看板列内的卡片拖拽。实现路线取自定版原型 B（docs/decisions.md D42）：
 * 指针事件自己实现，克隆一张卡片跟随光标，落点实时反映到看板上（乐观重排）。
 *
 * 为什么不用原生 HTML5 拖放（原型 A）：幽灵图的外观由浏览器决定，拖拽期间无法自定样式，
 * 也拿不到「会落到哪一格」的精确预览。代价是下面这些细节要自己管：
 * 点击与拖拽的区分、滚动时克隆卡片的位置、指针离开列时的取消。
 *
 * 阈值、抑制窗口、监听器装卸这些指针脚手架在 hooks/usePointerDrag（与任务树共用）；
 * 这个 hook 只留卡片特有的两件事：DOM 命中测试给出的列内落点，以及克隆卡片的预览状态。
 * 它不认识看板数据：命中的落点交给调用方换算成后端要的 position（看板里可能混着
 * 不参与重排的归档卡片，见 domain/board.ts）。
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

/** 按下时抓到的载荷：任务本身，加上克隆卡片对齐要用的几何。 */
interface CardDragPayload {
  task: BoardTask;
  grabX: number;
  grabY: number;
  width: number;
  height: number;
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
  /** 克隆卡片的位置：拖动期间每一帧都要更新，所以只有它需要 state。 */
  const [preview, setPreview] = useState<CardDragPreview | null>(null);

  const drag = usePointerDrag<CardDragPayload, DropSlot>({
    resolveSlot: (clientX, clientY) => options.resolveDrop(clientX, clientY),
    // 同一列的同一张卡片之前算同一个落点：不去重的话每一帧都会触发一次乐观重排。
    isSameSlot: (a, b) => a.columnId === b.columnId && a.beforeTaskId === b.beforeTaskId,
    // 已归档的卡片不能改（后端对归档任务的 PATCH 一律拒绝，见 D16），干脆不给拖。
    canBegin: (payload) => payload.task.archivedAt === null,
    onStart: (payload) => options.onStart(payload.task.id),
    onSlotChange: (slot) => options.onPreview(slot),
    onMove: (event, _slot, payload) =>
      setPreview({
        task: payload.task,
        clientX: event.clientX,
        clientY: event.clientY,
        grabX: payload.grabX,
        grabY: payload.grabY,
        width: payload.width,
        height: payload.height,
      }),
    onDrop: (slot) => options.onDrop(slot),
    onCancel: () => options.onCancel(),
  });

  const begin = useCallback(
    (task: BoardTask, event: ReactPointerEvent<HTMLElement>): boolean => {
      // React 派发结束后 currentTarget 会被清空，而 create 延迟到通用 hook 接受这一次按下
      // （主键、没有拖拽在跑）之后才调用，所以先把元素抓在手里。已归档的判断在 create 之后，
      // 那一种按下会白量一次矩形，可以接受。
      const target = event.currentTarget;
      return drag.begin(event, () => {
        const rect = target.getBoundingClientRect();
        return {
          task,
          grabX: event.clientX - rect.left,
          grabY: event.clientY - rect.top,
          width: rect.width,
          height: rect.height,
        };
      });
    },
    [drag.begin],
  );

  return {
    draggingTaskId: drag.active?.task.id ?? null,
    // 预览只在拖拽中成立：stop() 会把 active 置空，不必再单独清一次 preview。
    preview: drag.active === null ? null : preview,
    pressed: drag.pressed,
    begin,
    canOpen: drag.canOpen,
  };
}
