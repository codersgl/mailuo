import { DOING_COLUMN_ID } from '../domain/columns';
import { cx } from '../lib/cx';
import { TaskCard } from './TaskCard';
import type { BoardColumn } from '../api/types';

/** 看板里的一列：列头（列名 + 任务数）+ 卡片列表。 */
export function Column({
  column,
  onOpenTask,
}: {
  column: BoardColumn;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col">
      <div className="sticky top-0 z-[5] flex items-center gap-[7px] border-b border-line bg-canvas px-0.5 pt-3 pb-[9px]">
        <h2 className="text-[12px] font-semibold tracking-[0.3px] text-ink-2">{column.name}</h2>
        <span
          className={cx(
            'min-w-4 rounded-lg px-[5px] text-center text-[11px] leading-4 tabular-nums',
            column.id === DOING_COLUMN_ID ? 'bg-accent-weak text-accent' : 'bg-track text-ink-2',
          )}
        >
          {column.tasks.length}
        </span>
      </div>

      <div className="flex flex-col gap-2 pt-2.5">
        {column.tasks.length === 0 ? (
          // 空列在刚建库时是常态，给一行弱提示，避免看起来像加载失败。
          <p className="px-0.5 text-[11px] text-ink-3">暂无任务</p>
        ) : (
          column.tasks.map((task) => (
            <TaskCard key={task.id} task={task} onOpen={onOpenTask} />
          ))
        )}
      </div>
    </section>
  );
}
