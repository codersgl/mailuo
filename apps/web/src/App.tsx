import { useCallback, useEffect, useState } from 'react';
import { BoardView } from './components/BoardView';
import type { NewTaskControls } from './components/Column';
import { Sidebar } from './components/Sidebar';
import { ErrorNote, LoadingNote } from './components/StatusNote';
import { TaskEditorPanel } from './components/TaskEditorPanel';
import { TopBar } from './components/TopBar';
import { useBoard } from './hooks/useBoard';
import { useBreadcrumb } from './hooks/useBreadcrumb';
import { usePersistentState } from './hooks/usePersistentState';
import { useRoute } from './hooks/useRoute';
import { useTaskActions } from './hooks/useTaskActions';
import type { WriteResult } from './hooks/useTaskActions';
import { SHOW_ARCHIVED_KEY } from './lib/preferences';
import type { TaskFieldsPatch } from './api/client';
import type { BoardTask } from './api/types';

const isBoolean = (value: unknown): boolean => typeof value === 'boolean';

/**
 * 应用外壳：先按 URL 决定看哪一层看板，再交给 BoardPage 渲染。
 * 拆成两个组件是为了让 BoardPage 里的 hooks 顺序稳定：App 里只有一个 useRoute,
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

/**
 * 一个看板页：顶栏 + 左侧文件树 + 右侧看板 + 任务详情抽屉。
 *
 * 这一层是「页面数据」的唯一持有者：看板、文件树（数据在 Sidebar 内部取，靠 refreshToken 触发）、
 * 面包屑都在这里被安排重取，写操作因此只有一个刷新入口。
 */
function BoardPage({
  boardId,
  onNavigate,
}: {
  boardId: string | null;
  onNavigate: (boardId: string | null) => void;
}) {
  // 「显示已归档」总开关：看板列与文件树都认它。只存前端，不落库（见 docs/spec.md 的「归档」）。
  const [showArchived, setShowArchived] = usePersistentState(SHOW_ARCHIVED_KEY, false, isBoolean);
  const board = useBoard(boardId, showArchived);
  const breadcrumb = useBreadcrumb(boardId);

  /** 写操作成功后自增，让 Sidebar 静默重取一次任务树（D34 遗留的那条待办）。 */
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  /** 正在编辑的任务快照。抽屉的字段与保存后的归一化都以它起步。 */
  const [editing, setEditing] = useState<BoardTask | null>(null);
  const [creatingColumnId, setCreatingColumnId] = useState<string | null>(null);
  /**
   * 卡片菜单里的归档与删除没有表单可以就地报错（抽屉不再是它们的入口），
   * 失败时在看板顶部给一行可关闭的提示。
   */
  const [actionError, setActionError] = useState<string | null>(null);

  const { refresh: refreshBoard } = board;
  const { refresh: refreshBreadcrumb } = breadcrumb;
  const refreshAll = useCallback(() => {
    refreshBoard();
    refreshBreadcrumb();
    setTreeRefreshToken((token) => token + 1);
  }, [refreshBoard, refreshBreadcrumb]);

  const actions = useTaskActions(refreshAll);

  // 换一层看板就把抽屉、新建行与上一条操作错误收起来：它们都属于上一层看板，留着只会让人误会。
  useEffect(() => {
    setEditing(null);
    setCreatingColumnId(null);
    setActionError(null);
  }, [boardId]);

  const closeEditor = useCallback(() => setEditing(null), []);
  const cancelCreate = useCallback(() => setCreatingColumnId(null), []);

  async function saveTask(patch: TaskFieldsPatch): Promise<WriteResult> {
    if (editing === null) return { ok: false, message: '没有正在编辑的任务' };
    return actions.update(editing.id, patch);
  }

  /** 卡片的「⋯」菜单里归档或取消归档。 */
  async function setTaskArchived(task: BoardTask, archived: boolean) {
    setActionError(null);
    const result = await actions.setArchived(task.id, archived);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    // 归档正在编辑的任务时把抽屉收掉：已归档的任务不能改字段，留着一个改不动的抽屉没有意义。
    // 鼠标其实走不到这条：抽屉的遮罩盖住整块看板，卡片菜单点不到。只有「Tab 绕回看板 + 回车」
    // 这条键盘路径会命中，保留是免得那个状态下抽屉显示成可编辑。
    if (archived) setEditing((current) => (current?.id === task.id ? null : current));
  }

  /** 卡片的「⋯」菜单里删除（确认步骤在卡片上完成）。 */
  async function deleteTask(task: BoardTask) {
    setActionError(null);
    const result = await actions.remove(task.id);
    if (!result.ok) setActionError(result.message);
  }

  const create: NewTaskControls = {
    creatingColumnId,
    start: setCreatingColumnId,
    cancel: cancelCreate,
    submit: async (columnId, title) => {
      const result = await actions.create({ parentId: boardId, columnId, title });
      if (result.ok) setCreatingColumnId(null);
      return result;
    },
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar
        crumbs={breadcrumb.state.status === 'ready' ? breadcrumb.state.data : null}
        onNavigate={onNavigate}
      />
      {/* relative 是给抽屉当定位基准的：抽屉要盖住看板区但不随看板横向滚动一起跑。 */}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar
          boardId={boardId}
          onNavigate={onNavigate}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          refreshToken={treeRefreshToken}
        />
        <main className="min-w-0 flex-1 overflow-auto">
          {actionError !== null && (
            // sticky：提示条是 main 的第一个子元素，长看板下 main 会滚动，不粘住就会滚出视野。
            // role="alert" 让读屏立刻播报（看板区没有别的地方会报这个错）。
            <div
              role="alert"
              className="sticky top-0 z-[6] mx-4 mt-3 flex items-start gap-2 rounded-[5px] border border-line bg-surface px-2.5 py-1.5"
            >
              <p className="min-w-0 flex-1 text-[11.5px] text-danger">{actionError}</p>
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="flex-none text-[11.5px] text-ink-3 hover:text-ink"
              >
                关闭
              </button>
            </div>
          )}
          {board.state.status === 'loading' && <LoadingNote />}
          {board.state.status === 'failed' && (
            <ErrorNote message={board.state.message} onRetry={board.reload} />
          )}
          {board.state.status === 'ready' && (
            <BoardView
              board={board.state.data}
              onOpenTask={onNavigate}
              onEditTask={setEditing}
              onSetArchived={setTaskArchived}
              onDeleteTask={deleteTask}
              create={create}
            />
          )}
        </main>

        {editing !== null && (
          // key 用任务 id：换一个任务就整体重置表单草稿，不用写 effect 去同步 props。
          <TaskEditorPanel key={editing.id} task={editing} onClose={closeEditor} onSave={saveTask} />
        )}
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
