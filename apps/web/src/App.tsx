import { BoardView } from './components/BoardView';
import { Sidebar } from './components/Sidebar';
import { ErrorNote, LoadingNote } from './components/StatusNote';
import { TopBar } from './components/TopBar';
import { useBoard } from './hooks/useBoard';
import { useBreadcrumb } from './hooks/useBreadcrumb';
import { useRoute } from './hooks/useRoute';

/**
 * 应用外壳：先按 URL 决定看哪一层看板，再交给 BoardPage 渲染。
 * 拆成两个组件是为了让 BoardPage 里的 hooks 顺序稳定：App 里只有一个 useRoute，
 * 认不出的地址走另一条分支，不会出现「有时多调一个 hook」。
 */
export function App() {
  const { route, navigate } = useRoute();

  if (route.kind === 'notFound') {
    // 用 replace：坏地址不该留在历史里等着被后退回来。
    return <NotFound pathname={route.pathname} onBackToRoot={() => navigate(null, { replace: true })} />;
  }
  return <BoardPage boardId={route.boardId} onNavigate={navigate} />;
}

/** 一个看板页：顶栏 + 左侧文件树 + 右侧看板。boardId 为 null 时是根看板。 */
function BoardPage({
  boardId,
  onNavigate,
}: {
  boardId: string | null;
  onNavigate: (boardId: string | null) => void;
}) {
  const board = useBoard(boardId);
  const breadcrumb = useBreadcrumb(boardId);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar
        crumbs={breadcrumb.state.status === 'ready' ? breadcrumb.state.data : null}
        onNavigate={onNavigate}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar boardId={boardId} onNavigate={onNavigate} />
        <main className="min-w-0 flex-1 overflow-auto">
          {board.state.status === 'loading' && <LoadingNote />}
          {board.state.status === 'failed' && (
            <ErrorNote message={board.state.message} onRetry={board.reload} />
          )}
          {board.state.status === 'ready' && (
            <BoardView board={board.state.data} onOpenTask={onNavigate} />
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * 认不出的地址。不静默显示根看板：地址栏停在 `/nonsense` 却显示根看板，
 * 会让人以为这个地址是可用的（见 lib/route.ts）。pathname 由路由带进来，这里不读全局。
 */
function NotFound({ pathname, onBackToRoot }: { pathname: string; onBackToRoot: () => void }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3">
      <p className="text-[13px] text-ink-2">地址认不出来：{pathname}</p>
      <button
        type="button"
        onClick={onBackToRoot}
        className="h-[26px] rounded-[5px] border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink"
      >
        回根看板
      </button>
    </div>
  );
}
