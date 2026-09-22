import type { Board, BoardTask } from '../api/types';
import { Column } from './Column';
import type { NewTaskControls } from './Column';

/**
 * 三列看板。列的 id、名称、顺序都取自后端返回的 board.columns；
 * 这里的三等分网格只是布局（规范把列固定为待办 / 进行中 / 完成三列）。
 *
 * min-w 让内容区变窄时出现横向滚动，而不是把三列压得过窄；
 * 滚动容器是外面那层 main（见 App.tsx），列头的 sticky 相对它生效。
 */
export function BoardView({
  board,
  onOpenTask,
  onEditTask,
  onSetArchived,
  onDeleteTask,
  create,
}: {
  board: Board;
  onOpenTask: (taskId: string) => void;
  onEditTask: (task: BoardTask) => void;
  onSetArchived: (task: BoardTask, archived: boolean) => void;
  onDeleteTask: (task: BoardTask) => void;
  create: NewTaskControls;
}) {
  return (
    <div className="grid min-w-[780px] grid-cols-3 items-start gap-3.5 px-4 pb-7">
      {board.columns.map((column) => (
        <Column
          key={column.id}
          column={column}
          onOpenTask={onOpenTask}
          onEditTask={onEditTask}
          onSetArchived={onSetArchived}
          onDeleteTask={onDeleteTask}
          create={create}
        />
      ))}
    </div>
  );
}
