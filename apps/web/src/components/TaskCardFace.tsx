import { DONE_COLUMN_ID } from '../domain/columns';
import { cx } from '../lib/cx';
import { formatDuration, formatProgress, isDurationEstimated, progressPercent } from '../lib/format';
import type { BoardTask } from '../api/types';

/**
 * 卡片的正面：标题、描述（有才显示）、进度条 + 计数 + 工期胶囊 + 归档标记。
 *
 * 抽出来是因为拖拽的克隆卡片（DragGhost）与看板里的卡片（TaskCard）要长得一模一样，
 * 而拖动期间两处同时在屏幕上，样式一旦分叉就会一眼看出「克隆的和真的不一样」。
 * 里层元素一律用 span：它可能被放进 button（TaskCard 的主体），button 只允许短语内容。
 */
export function TaskCardFace({ task, archived }: { task: BoardTask; archived: boolean }) {
  const isDone = task.columnId === DONE_COLUMN_ID;
  const estimated = isDurationEstimated(task.durationMinutes);

  return (
    <>
      {/* pr-5 给右上角的「⋯」让出位置，长标题不会跑到它下面。 */}
      <span
        className={cx(
          'block pr-5 text-[13px] leading-[1.35]',
          isDone ? 'font-medium text-ink-2' : 'font-semibold',
        )}
      >
        {task.title}
      </span>

      {/* 没有描述就整行不显示，而不是显示一个占位词（原型 A 的做法）。 */}
      {task.description !== '' && (
        <span className="mt-[3px] block truncate text-[12px] text-ink-2">{task.description}</span>
      )}

      <span className="mt-2 flex items-center gap-2">
        {/* 进度条是纯装饰，信息由旁边「1/2 子任务」的文字表达。 */}
        <span
          className="h-[3px] w-14 flex-none overflow-hidden rounded-[2px] bg-track"
          aria-hidden="true"
        >
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
        {/* 归档标记跟在工期后面（与任务树一样靠右），不挤占标题那一行和右上角的「⋯」。 */}
        {archived && (
          <span className="flex-none rounded-[4px] border border-dashed border-line-strong px-1 text-[10px] italic leading-[14px] text-ink-3">
            归档
          </span>
        )}
      </span>
    </>
  );
}
