import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Board, BoardTask } from '../api/types';
import type { DropSlot } from '../domain/board';
import { CARD_ATTR } from '../hooks/useCardDrag';
import { useCardFlip } from '../hooks/useCardFlip';
import type { CardDragPreview } from '../hooks/useCardDrag';
import { useNow } from '../hooks/useNow';
import { Column } from './Column';
import type { NewTaskControls } from './Column';
import { DragGhost } from './DragGhost';

/**
 * 三列看板。列的 id、名称、顺序都取自后端返回的 board.columns；
 * 这里的三等分网格只是布局（规范把列固定为待办 / 进行中 / 完成三列）。
 *
 * min-w 让内容区变窄时出现横向滚动，而不是把三列压得过窄；
 * 滚动容器是主区里「工具栏之下」的那层 div（见 App.tsx；D50 把 main 改成了竖向 flex，
 * 滚动交给它的第二个子元素），列头的 sticky 相对它生效。
 *
 * 拖拽相关的三件事都在这一层：让位动画（FLIP）、插入线、跟随光标的克隆卡片。
 * 「指针压在哪一列哪张卡片之前」由 hooks/useCardDrag 的 resolveDropSlot 产出，
 * 「这个落点等于后端的哪个 position」由 BoardPage 换算。
 */
export function BoardView({
  board,
  dragPreview,
  dragSlot,
  draggingTaskId,
  onOpenTask,
  onEditTask,
  onSetArchived,
  onDeleteTask,
  onDragStart,
  create,
}: {
  board: Board;
  /** 非空表示正在拖拽：克隆卡片与插入线只在此时出现。 */
  dragPreview: CardDragPreview | null;
  /** 当前落点；指针在列外时为 null，此时不画插入线。 */
  dragSlot: DropSlot | null;
  draggingTaskId: string | null;
  onOpenTask: (taskId: string) => void;
  onEditTask: (task: BoardTask) => void;
  onSetArchived: (task: BoardTask, archived: boolean) => void;
  onDeleteTask: (task: BoardTask) => void;
  onDragStart: (task: BoardTask, event: ReactPointerEvent<HTMLElement>) => void;
  create: NewTaskControls;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  useCardFlip(gridRef, draggingTaskId !== null, board);
  // 卡片上的工期提醒会随时间的流逝变档，所以整块看板共用一个 30 秒的 tick（见 hooks/useNow）。
  const nowMs = useNow();

  return (
    <>
      {/*
        relative 是插入线的定位基准。
        h-full 是「列尾那片空白也能放」的前提：网格之前是内容高（实测 142px，而当时的滚动容器是 575px），
        `items-start` 只管列自身的对齐、不会把网格撑高，于是 Column 上的 self-stretch 无处可撑，
        整列只有内容那么高。height:100% 让网格恒等于滚动容器的高度（D50 之后是主区里工具栏之下的
        那层 div），内容超过一屏时由它滚动。

        底部留白（pb-7）放在 Column 上而不是这里：padding 属于元素自己的盒子，能被
        elementFromPoint 命中，父容器的 padding 不能。放在网格上的话，最后 28px 会成死区——
        指针落在那里时 closest('[data-column-id]') 找不到列，插入线消失、松手不生效。
      */}
      <div ref={gridRef} className="relative grid h-full min-w-[780px] grid-cols-3 gap-3.5 px-4">
        {board.columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            draggingTaskId={draggingTaskId}
            nowMs={nowMs}
            onOpenTask={onOpenTask}
            onEditTask={onEditTask}
            onSetArchived={onSetArchived}
            onDeleteTask={onDeleteTask}
            onDragStart={onDragStart}
            create={create}
          />
        ))}
        {dragPreview !== null && <DropLine board={board} slot={dragSlot} gridRef={gridRef} />}
      </div>
      {dragPreview !== null && <DragGhost preview={dragPreview} nowMs={nowMs} />}
    </>
  );
}

/**
 * 卡片之间的插入线。绝对定位在看板网格上，所以它不会挤动任何卡片——
 * 插一个真的占位元素会让整列跳一下。
 *
 * 位置靠测量目标卡片的实时矩形算出：拖拽中卡片顺序在变（乐观重排），
 * 算出来的值必须跟着变，所以每次落点或看板变化都重量一次。
 */
function DropLine({
  board,
  slot,
  gridRef,
}: {
  board: Board;
  slot: DropSlot | null;
  gridRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);

  const measure = useCallback(() => {
    const grid = gridRef.current;
    if (slot === null || grid === null) {
      setRect(null);
      return;
    }

    // 目标列的卡片列表：插入线的左右边界与「列尾」的纵坐标都从这里取。
    const body = grid.querySelector<HTMLElement>(
      `[data-column-id="${slot.columnId}"] [data-column-body]`,
    );
    if (body === null) {
      setRect(null);
      return;
    }
    const bodyRect = body.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();

    // 锚点卡片在乐观重排之后的位置。找不到时（数据已过期）退到列尾。
    const anchor =
      slot.beforeTaskId === null
        ? null
        : grid.querySelector<HTMLElement>(`[${CARD_ATTR}="${slot.beforeTaskId}"]`);
    const top = anchor === null ? bodyRect.bottom : anchor.getBoundingClientRect().top;

    setRect({
      left: bodyRect.left - gridRect.left,
      top: top - gridRect.top,
      width: bodyRect.width,
    });
  }, [slot, gridRef]);

  // 用 layout effect：拖拽中每一轮重渲染都要在绘制前量好，否则插入线会先画在旧位置再跳一下。
  useLayoutEffect(() => {
    measure();
  }, [measure, board]);

  // 滚动与改窗高会让测量结果失效。滚动事件不冒泡，捕获阶段才能听到滚动容器（主区里
  // 工具栏之下那层 div，见 D50）的滚动——事件目标变了，但这个监听挂在 window 上，照样收得到。
  useEffect(() => {
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  if (rect === null) return null;

  return (
    <div
      className="pointer-events-none absolute z-10 h-0.5 rounded-[1px] bg-accent"
      style={{ left: rect.left, top: rect.top - 1, width: rect.width }}
      aria-hidden="true"
    />
  );
}
