import { BoardView } from './components/BoardView';
import { TopBar } from './components/TopBar';
import { useBoard } from './hooks/useBoard';

/** 应用外壳：顶部栏 + 内容区。内容区目前只有根看板。 */
export function App() {
  const { state, reload } = useBoard(null);

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      {state.status === 'loading' && (
        <p className="flex-1 px-4 py-6 text-[12.5px] text-ink-3">加载中…</p>
      )}
      {state.status === 'failed' && (
        <div className="flex-1 px-4 py-6">
          <p className="text-[12.5px] text-ink-2">{state.message}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-3 h-[26px] rounded-[5px] border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink"
          >
            重试
          </button>
        </div>
      )}
      {state.status === 'ready' && <BoardView board={state.board} />}
    </div>
  );
}
