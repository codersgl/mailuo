import { DONE_COLUMN_ID } from '../domain/columns';
import { NO_REMINDER, reminderView } from '../domain/reminder';
import { branchView } from '../domain/subtreeTime';
import type { SubtreeTime } from '../domain/subtreeTime';
import { cx } from '../lib/cx';
import { formatDuration, formatProgress, isDurationEstimated, progressPercent } from '../lib/format';
import type { BoardTask } from '../api/types';
import { DurationBar } from './DurationBar';

/**
 * 卡片的正面：标题、描述（有才显示）、进度条 + 计数 + 工期胶囊 + 归档标记，
 * 以及工期提醒的进度条与小字（定版原型 B）。
 *
 * 抽出来是因为拖拽的克隆卡片（DragGhost）与看板里的卡片（TaskCard）要长得一模一样，
 * 而拖动期间两处同时在屏幕上，样式一旦分叉就会一眼看出「克隆的和真的不一样」。
 * 里层元素一律用 span：它可能被放进 button（TaskCard 的主体），button 只允许短语内容。
 *
 * `nowMs` 由上层整块传下来（见 hooks/useNow 的说明），不在每张卡片里各挂一个定时器。
 */
export function TaskCardFace({
  task,
  archived,
  nowMs,
  subtree,
}: {
  task: BoardTask;
  archived: boolean;
  /** 当前时刻，用于算「已用多久 / 还剩多久」。 */
  nowMs: number;
  /**
   * 这棵子树的时间汇总（domain/subtreeTime.ts）；null 表示这份数据还没到
   * （任务树没取回来或取失败）。只有父任务会用到它。
   */
  subtree?: SubtreeTime | null;
}) {
  const isDone = task.columnId === DONE_COLUMN_ID;
  const estimated = isDurationEstimated(task.durationMinutes);
  /**
   * 有子任务的父任务画的是**子树聚合**，不是它自己的工期。
   *
   * 它自己的列由子任务推导（见 docs/spec.md 的「状态语义」），而且表是停的
   * （api 的 domain/clock.ts 只让叶子计时）——拿它自己的工期估算与一个永远不动的已用画提醒条
   * 只会误导人，所以 D76 先把那条假条摘了。这里补上真口径：Σ 未归档叶子的已用 / Σ 它们的工期。
   * 子树里有叶子未估工期时没有可信的分母，就只报「已用 X / 未估」，既不画条也不给临近/超期
   * （B 版原型，见 docs/decisions.md D77）。
   *
   * 汇总拿不到（undefined/null）、或汇总里一片叶子都没有时按「不画」处理：宁可暂时不显示，
   * 也不要拿任务自己的工期顶上去——那正是被摘掉的假数据。
   */
  const hasChildren = task.childTotal > 0;
  const branch = hasChildren && subtree != null && subtree.leafCount > 0
    ? branchView(subtree, task, nowMs)
    : null;
  const reminder =
    branch !== null ? branch.reminder : hasChildren ? NO_REMINDER : reminderView(task, nowMs);

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
        {/* 工期胶囊只画给叶子：父任务的那个估算不再是展示口径，它看下面的聚合胶囊。 */}
        {!hasChildren && (
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
        )}
        {/* 归档标记跟在工期后面（与任务树一样靠右），不挤占标题那一行和右上角的「⋯」。
            没有工期胶囊时它自己顶到右边。 */}
        {archived && (
          <span
            className={cx(
              'flex-none rounded-[4px] border border-dashed border-line-strong px-1 text-[10px] italic leading-[14px] text-ink-3',
              hasChildren && 'ml-auto',
            )}
          >
            归档
          </span>
        )}
      </span>

      {/*
        父任务的分支投入单独占一行，而不是挤进上面那一行：260px 的列里
        「56px 进度条 + 2/3 子任务 + 已用 1 天 3 小时 / 1 天 4 小时」放不下（定版原型 B）。
        title 放完整文案：胶囊上只能写分数与「未估」，为什么没有进度、Σ 的口径都写在这里。
      */}
      {branch !== null && (
        <span className="mt-1.5 flex">
          <span
            title={branch.detail}
            className={cx(
              'flex-none whitespace-nowrap rounded-[4px] border px-1.5 text-[11px] leading-4',
              branch.estimated
                ? 'border-line bg-surface-2 text-ink-2'
                : 'border-dashed border-line-strong bg-transparent text-ink-3',
            )}
          >
            {branch.capsule}
          </span>
        </span>
      )}

      {/* 提醒小字：只有「临近」与「超期」两档有字，还没到 90% 的进行中任务只有下面的条。 */}
      {reminder.note !== null && (
        <span
          title={reminder.detail}
          className={cx(
            'mt-[5px] flex justify-end text-[11px] leading-4 tabular-nums',
            reminder.noteKind === 'over' ? 'text-danger' : 'text-accent',
          )}
        >
          {reminder.note}
        </span>
      )}

      {/*
        贴卡片下沿的 2px 进度条。绝对定位的包含块是卡片（article）：这里虽然是 button 的子元素，
        但 button 没有定位，所以 inset-x-0/bottom-0 落在卡片下沿，而不是被按钮的内边距缩进去。
        卡片自己不能加 overflow-hidden（右上角的「⋯」菜单要伸出卡片），所以圆角单独给这条。
      */}
      {reminder.fill !== null && (
        <DurationBar
          fill={reminder.fill}
          percent={reminder.percent}
          detail={reminder.detail}
          // 有小字时条只是装饰，避免读屏把同一件事念两遍。
          accessible={reminder.note === null}
          className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden rounded-b-[4px] bg-track"
        />
      )}
    </>
  );
}
