import { DONE_COLUMN_ID } from '../domain/columns';
import { cx } from '../lib/cx';
import { formatDuration, formatProgress, isDurationEstimated, progressPercent } from '../lib/format';
import type { BoardTask } from '../api/types';

/**
 * 看板里的一张卡片。
 *
 * 卡片主体是一个按钮，点它进入该任务的看板；右上角的编辑入口是它的**兄弟节点**，不能嵌在里面
 * ——两个不同热区必须分得开，否则编辑时会误入下层（见 docs/spec.md 的「界面行为」）。
 * 主体按钮里的子元素全用 span：button 只允许短语内容（phrasing content），塞 div / h3 是无效 HTML。
 *
 * 编辑按钮一直可见（低对比度，悬停变深），不学原型那样只在 hover 时出现：hover-only 的控件
 * 键盘和触屏都点不到。
 */
export function TaskCard({
  task,
  onOpen,
  onEdit,
}: {
  task: BoardTask;
  onOpen: (taskId: string) => void;
  onEdit: (task: BoardTask) => void;
}) {
  const isDone = task.columnId === DONE_COLUMN_ID;
  const estimated = isDurationEstimated(task.durationMinutes);
  const archived = task.archivedAt !== null;

  return (
    <article
      className={cx(
        'relative rounded-[5px] border bg-surface hover:border-accent-border',
        // 归档卡片用虚线边框，和文件树里的归档节点同一套语言。
        archived ? 'border-dashed border-line-strong' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="block w-full rounded-[5px] px-[11px] py-[9px] text-left"
      >
        {/* pr-5 给右上角的编辑按钮让出位置，长标题不会跑到它下面。 */}
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
          <span className="mt-[3px] block truncate text-[12px] text-ink-2">
            {task.description}
          </span>
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
          {/* 归档标记跟在工期后面（与文件树一样靠右），不挤占标题那一行和右上角的编辑按钮。 */}
          {archived && (
            <span className="flex-none rounded-[4px] border border-dashed border-line-strong px-1 text-[10px] italic leading-[14px] text-ink-3">
              归档
            </span>
          )}
        </span>
      </button>

      <button
        type="button"
        onClick={() => onEdit(task)}
        aria-label={`编辑「${task.title}」`}
        className="absolute right-1 top-1 grid size-5 place-items-center rounded-[4px] text-ink-3 hover:bg-track hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border"
      >
        {/* 铅笔图标，纯装饰：按钮的无障碍名称由 aria-label 给出。 */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8.2 1.8 10.2 3.8 4.4 9.6 1.9 10.1 2.4 7.6z" />
        </svg>
      </button>
    </article>
  );
}
