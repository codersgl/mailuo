import type { CardDragPreview } from '../hooks/useCardDrag';
import { TaskCardFace } from './TaskCardFace';

/**
 * 跟随光标的克隆卡片（定版原型 B）。放在 body 的固定层里，不参与看板布局，
 * 所以拖动它不会影响任何列的滚动与高度。
 *
 * 尺寸与位置取自被拖卡片按下时的快照：宽度用内联样式钉死（换列后列宽可能不同，
 * 克隆卡片要保持原样），位置让卡片左上角跟着「按下时抓住的那个点」走。
 */
export function DragGhost({ preview }: { preview: CardDragPreview }) {
  const { task, clientX, clientY, grabX, grabY, width, height } = preview;

  return (
    <div
      className="pointer-events-none fixed z-30"
      style={{
        left: clientX - grabX,
        top: clientY - grabY,
        width,
        height,
      }}
      aria-hidden="true"
    >
      <div className="h-full rounded-[5px] border border-accent-border bg-surface px-[11px] py-[9px] shadow-[0_10px_24px_rgba(29,33,38,0.22)]">
        <TaskCardFace task={task} archived={false} />
      </div>
    </div>
  );
}
