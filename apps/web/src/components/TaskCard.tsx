import { DONE_COLUMN_ID } from '../domain/columns';
import { cx } from '../lib/cx';
import { formatDuration, formatProgress, isDurationEstimated, progressPercent } from '../lib/format';
import type { BoardTask } from '../api/types';

/** 看板里的一张卡片。本步只读：点卡片进子看板、右上角编辑入口都还没做。 */
export function TaskCard({ task }: { task: BoardTask }) {
  const isDone = task.columnId === DONE_COLUMN_ID;
  const estimated = isDurationEstimated(task.duration);

  return (
    <article className="rounded-[5px] border border-line bg-surface hover:border-accent-border">
      <div className="px-[11px] py-[9px]">
        <h3
          className={cx(
            'text-[13px] leading-[1.35]',
            isDone ? 'font-medium text-ink-2' : 'font-semibold',
          )}
        >
          {task.title}
        </h3>

        {/* 没有描述就整行不显示，而不是显示一个占位词（原型 A 的做法）。 */}
        {task.description !== '' && (
          <p className="mt-[3px] truncate text-[12px] text-ink-2">{task.description}</p>
        )}

        <div className="mt-2 flex items-center gap-2">
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
            {formatDuration(task.duration)}
          </span>
        </div>
      </div>
    </article>
  );
}
