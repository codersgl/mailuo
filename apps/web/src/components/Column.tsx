import type { PointerEvent as ReactPointerEvent } from 'react';
import { DOING_COLUMN_ID } from '../domain/columns';
import { cx } from '../lib/cx';
import type { WriteResult } from '../hooks/useTaskActions';
import type { BoardColumn, BoardTask } from '../api/types';
import { NewTaskForm } from './NewTaskForm';
import { TaskCard } from './TaskCard';

/**
 * 「新建任务」这条链路的入参。抽成一个对象往下传，免得 BoardView 与 Column 各背四个 props。
 * 同一时刻只允许一列处于新建态（creatingColumnId），避免两个半截表单同时开着。
 */
export interface NewTaskControls {
  creatingColumnId: string | null;
  start: (columnId: string) => void;
  cancel: () => void;
  submit: (columnId: string, title: string) => Promise<WriteResult>;
}

/** 看板里的一列：列头（列名 + 任务数 + 新建入口）+ 卡片列表。 */
export function Column({
  column,
  draggingTaskId,
  onOpenTask,
  onEditTask,
  onSetArchived,
  onDeleteTask,
  onDragStart,
  create,
}: {
  column: BoardColumn;
  /** 正被拖动的任务 id；它所在的卡片留在原位当占位。 */
  draggingTaskId: string | null;
  onOpenTask: (taskId: string) => void;
  onEditTask: (task: BoardTask) => void;
  onSetArchived: (task: BoardTask, archived: boolean) => void;
  onDeleteTask: (task: BoardTask) => void;
  onDragStart: (task: BoardTask, event: ReactPointerEvent<HTMLElement>) => void;
  create: NewTaskControls;
}) {
  const creating = create.creatingColumnId === column.id;

  return (
    // self-stretch 让列体撑满网格行高（外层网格是 items-start）。这不只是好看：
    // 列尾的空白是「拖到本列末尾」唯一的落点，列只有内容高的话，最后一张卡片下面就没有地方可放。
    <section data-column-id={column.id} className="flex min-w-0 flex-col self-stretch">
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
        {/* 新建入口放在列头而不是列底：列底的位置会被卡片推着往下跑。 */}
        <button
          type="button"
          onClick={() => create.start(column.id)}
          aria-label={`在「${column.name}」新建任务`}
          title="新建任务"
          className="ml-auto grid size-[18px] place-items-center rounded-[4px] text-ink-3 hover:bg-track hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 2.5v7M2.5 6h7" />
          </svg>
        </button>
      </div>

      <div data-column-body className="flex flex-col gap-2 pt-2.5">
        {column.tasks.length === 0 && !creating && (
          // 空列在刚建库时是常态，给一行弱提示，避免看起来像加载失败。
          <p className="px-0.5 text-[11px] text-ink-3">暂无任务</p>
        )}
        {column.tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            dragging={task.id === draggingTaskId}
            onOpen={onOpenTask}
            onEdit={onEditTask}
            onSetArchived={onSetArchived}
            onDelete={onDeleteTask}
            onDragStart={onDragStart}
          />
        ))}
        {creating && (
          <NewTaskForm
            columnName={column.name}
            onSubmit={(title) => create.submit(column.id, title)}
            onCancel={create.cancel}
          />
        )}
      </div>
    </section>
  );
}
