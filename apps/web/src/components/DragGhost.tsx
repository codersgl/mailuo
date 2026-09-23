import { DONE_COLUMN_ID } from '../domain/columns';
import { cx } from '../lib/cx';
import { formatDuration, formatProgress, isDurationEstimated, progressPercent } from '../lib/format';
import type { CardDragPreview } from '../hooks/useCardDrag';

/**
 * 跟随光标的克隆卡片（定版原型 B）。放在 body 的固定层里，不参与看板布局，
 * 所以拖动它不会影响任何列的滚动与高度。
 *
 * 尺寸与位置取自被拖卡片按下时的快照：宽度用内联样式钉死（换列后列宽可能不同，
 * 克隆卡片要保持原样），位置让卡片左上角跟着「按下时抓住的那个点」走。
 */
export function DragGhost({ preview }: { preview: CardDragPreview }) {
  const { task, clientX, clientY, grabX, grabY, width, height } = preview;
  const isDone = task.columnId === DONE_COLUMN_ID;
  const estimated = isDurationEstimated(task.durationMinutes);

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
        <span
          className={cx(
            'block pr-5 text-[13px] leading-[1.35]',
            isDone ? 'font-medium text-ink-2' : 'font-semibold',
          )}
        >
          {task.title}
        </span>

        {task.description !== '' && (
          <span className="mt-[3px] block truncate text-[12px] text-ink-2">
            {task.description}
          </span>
        )}

        <span className="mt-2 flex items-center gap-2">
          <span className="h-[3px] w-14 flex-none overflow-hidden rounded-[2px] bg-track">
            <i
              className="block h-full rounded-[2px] bg-accent"
              style={{ width: `${progressPercent(task.childDone, task.childTotal)}%` }}
            />
          </span>
          <span className={cx('text-[11px] tabular-nums', isDone ? 'text-accent' : 'text-ink-3')}>
            {formatProgress(task.childDone, task.childTotal)}
          </span>
          <span
            className={cx(
              'ml-auto flex-none whitespace-nowrap rounded-[4px] border px-1.5 text-[11px] leading-4',
              estimated
                ? 'border-line bg-surface-2 text-ink-2'
                : 'border-dashed border-line-strong bg-transparent text-ink-3',
            )}
          >
            {formatDuration(task.durationMinutes)}
          </span>
        </span>
      </div>
    </div>
  );
}
