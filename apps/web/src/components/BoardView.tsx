import type { Board } from '../api/types';
import { Column } from './Column';

/**
 * 三列看板。列的 id、名称、顺序都取自后端返回的 board.columns；
 * 这里的三等分网格只是布局（规范把列固定为待办 / 进行中 / 完成三列）。
 */
export function BoardView({ board }: { board: Board }) {
  return (
    <main className="grid min-h-0 flex-1 grid-cols-3 items-start gap-3.5 overflow-auto px-4 pb-7">
      {board.columns.map((column) => (
        <Column key={column.id} column={column} />
      ))}
    </main>
  );
}
