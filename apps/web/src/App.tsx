import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { BoardView } from './components/BoardView';
import type { NewTaskControls } from './components/Column';
import { DependencyGraph } from './components/DependencyGraph';
import { SearchResults } from './components/SearchResults';
import { Sidebar } from './components/Sidebar';
import { ErrorNote, LoadingNote } from './components/StatusNote';
import { TaskEditorPanel } from './components/TaskEditorPanel';
import { TopBar } from './components/TopBar';
import { ViewToolbar } from './components/ViewToolbar';
import type { ViewMode } from './components/ViewToolbar';
import { dropToMove, moveTaskInBoard } from './domain/board';
import type { DropSlot } from './domain/board';
import { flattenGroups, groupByColumn, moveSelection } from './domain/search';
import { useBoard } from './hooks/useBoard';
import { useBreadcrumb } from './hooks/useBreadcrumb';
import { resolveDropSlot, useCardDrag } from './hooks/useCardDrag';
import { useLayerSchedule } from './hooks/useLayerSchedule';
import { usePersistentState } from './hooks/usePersistentState';
import { useRoute } from './hooks/useRoute';
import { useSearch } from './hooks/useSearch';
import { useTaskActions } from './hooks/useTaskActions';
import type { WriteResult } from './hooks/useTaskActions';
import { SHOW_ARCHIVED_KEY } from './lib/preferences';
import type { TaskFieldsPatch } from './api/client';
import type { Board, BoardTask } from './api/types';

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
  /**
   * 主区正在看哪一种视图：看板列，还是这一层的依赖图（第三批）。
   * 只存在前端且不落盘：它是「这一次在看什么」，不是一项偏好（与文件树的折叠偏好不同）。
   * 换一层看板时不重置——在依赖图里顺着文件树往下看，是正常用法。
   */
  const [view, setView] = useState<ViewMode>('board');
  const board = useBoard(boardId, showArchived);
  const breadcrumb = useBreadcrumb(boardId);
  /**
   * 这一层的依赖图。抽屉里的「前置任务」用它，后续的图上标记也用它（见 D49）。
   * 固定取含归档的完整图：关着「显示已归档」时丢掉归档节点会让「已归档的前置」变成看不见的脏数据。
   */
  const schedule = useLayerSchedule(boardId);

  /**
   * 搜索状态。关键词非空时主区整块换成结果页（定版原型 C）。
   * 关键词的 trim 在这里做一次，供「是否在搜索态」与结果页回显共用，避免两处口径不一致。
   */
  const [keyword, setKeyword] = useState('');
  const trimmedKeyword = keyword.trim();
  const searching = trimmedKeyword !== '';
  const search = useSearch(keyword, showArchived);
  /** 键盘选中的结果下标（摊平后的顺序，见 domain/search.ts）。结果换了就回到第一条。 */
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 结果换了（新关键词、新开关、重试）就把选中项拉回第一条，否则选中项可能停在一个已经不存在的下标上。
  useEffect(() => {
    setSelectedIndex(0);
  }, [search.state]);

  const searchResults = search.state.status === 'ready' ? search.state.results : [];
  /**
   * 分组用的列名与列顺序来自搜索响应自带的列字典，不取自看板：搜索是全库的，
   * 当前这一层看板取不到（被别处删掉、请求失败）时结果页照样要能画出来。
   */
  const searchGroups = groupByColumn(
    searchResults,
    search.state.status === 'ready' ? search.state.columns : [],
  );
  const flatResults = flattenGroups(searchGroups);
  /**
   * 画面上的结果是不是属于「输入框里这个词 + 当前这个显示已归档开关」。打字与切开关都有 200ms
   * 防抖，这段时间里输入框/开关已经更新、结果还是上一批；Enter 必须等结果跟上再动作，
   * 否则会打开上一个关键词的那一条（见 docs/decisions.md D45）。
   */
  const resultsAreStale =
    search.state.status === 'ready' &&
    (search.state.keyword !== trimmedKeyword || search.state.includeArchived !== showArchived);

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
  const { refresh: refreshSchedule } = schedule;
  /** 有指针正按在卡片上（不管是待定的点击还是拖拽中）。用它给静默重取让路。 */
  const pointerActiveRef = useRef(false);
  const refreshAll = useCallback(() => {
    // 拖拽期间不要重取看板：后台 GET 回来的那一份是拖拽前的顺序，会把正在拖的卡片打回原位。
    // 松手后本来就会再重取一次，所以跳过这一次不会丢更新。面包屑与文件树不受影响。
    if (!pointerActiveRef.current) refreshBoard();
    refreshBreadcrumb();
    // 依赖图也跟着重取：工期、归档、增删任务都会改变关键路径，抽屉里的候选与禁用原因也要跟上。
    refreshSchedule();
    setTreeRefreshToken((token) => token + 1);
    // 搜索态下写操作也会让结果里的东西过期：文件树拖动会改层级路径，归档会改「已归档」标记。
    // 这种情况下唯一的写入口就是文件树，看板本身被结果页盖着。
    if (searching) search.retry();
  }, [refreshBoard, refreshBreadcrumb, refreshSchedule, searching, search.retry]);

  const actions = useTaskActions(refreshAll);

  // 换一层看板就把抽屉、新建行与上一条操作错误收起来：它们都属于上一层看板，留着只会让人误会。
  useEffect(() => {
    setEditing(null);
    setCreatingColumnId(null);
    setActionError(null);
  }, [boardId]);

  /**
   * 拖拽落定之后服务端才是准的，但等它返回再重画会让卡片先弹回原位、再跳到新位置。
   * 所以落点在指针移动时就换算成 position 并就地重排（乐观），松手时把同一个 position 发给后端；
   * 失败或取消就整体退回「按下时的看板」（见 docs/decisions.md D42）。
   */
  const boardRef = useRef<Board | null>(null);
  boardRef.current = board.state.status === 'ready' ? board.state.data : null;
  /**
   * 按下时的看板，用来回滚与换算落点。非空表示一次拖拽还没结束。
   * `layerId` 是按下时这一层的 parentId：拖拽期间看板对象会因乐观重排不停换新，
   * 所以判断「还是不是同一层」要比较这个，而不是比较对象身份。
   */
  const dragStartRef = useRef<{ board: Board; layerId: string | null } | null>(null);
  /** 被拖的任务 id。落点只描述「哪一列哪张卡片之前」，换算 position 还得知道是谁在动。 */
  const dragTaskRef = useRef<string | null>(null);
  /**
   * 当前落点，只给插入线用。用 state 而不是 ref：它是渲染要用的值，
   * 而每次变化都对应一次真实的落点切换（不是每帧），不会造成额外渲染。
   */
  const [dragSlot, setDragSlot] = useState<DropSlot | null>(null);

  const drag = useCardDrag({
    resolveDrop: resolveDropSlot,
    onStart: (taskId) => {
      const current = boardRef.current;
      if (current === null) return;
      dragStartRef.current = { board: current, layerId: current.parentId };
      dragTaskRef.current = taskId;
    },
    onPreview: (slot) => {
      /**
       * 只在「还停在按下时那一层」时重排。拖拽中若换了一层看板（点面包屑、后退）或切换了
       * 「显示已归档」，拿旧层的快照去改新数据会把别的层的卡片搬进来（审阅发现的边界）。
       * 注意不能比较看板对象身份：乐观重排每改一次就换一个新对象，那会把正常路径也挡掉。
       */
      const start = dragStartRef.current;
      if (start === null || boardRef.current?.parentId !== start.layerId) return;
      setDragSlot(slot);
      // 指针在列外：撤销预览，回到刚按下时的样子。
      if (slot === null) {
        board.mutate(() => start.board);
        return;
      }
      board.mutate((data) => {
        const taskId = dragTaskRef.current;
        if (taskId === null) return data;
        return moveTaskInBoard(data, { taskId, ...dropToMove(data, taskId, slot) });
      });
    },
    onDrop: (slot) => {
      const start = dragStartRef.current;
      const taskId = dragTaskRef.current;
      const sameLayer = boardRef.current?.parentId === start?.layerId;
      dragStartRef.current = null;
      setDragSlot(null);
      // 落在列外、层被换掉、或状态不全：撤销预览（正常情况下指针移出列时已经撤过一次，这里是兜底）。
      if (slot === null || start === null || taskId === null || !sameLayer) {
        if (start !== null && sameLayer) board.mutate(() => start.board);
        return;
      }
      const move = dropToMove(start.board, taskId, slot);
      void commitMove(taskId, move.columnId, move.position);
    },
    onCancel: () => {
      const start = dragStartRef.current;
      const sameLayer = boardRef.current?.parentId === start?.layerId;
      dragStartRef.current = null;
      setDragSlot(null);
      if (start !== null && sameLayer) board.mutate(() => start.board);
    },
  });

  /**
   * 一次拖拽结束了（或压根没开始，按下就松手）就把标记放下。
   *
   * 为什么要有这条兜底：`pointerActiveRef` 正常由 onDrop / onCancel 清掉，但如果 `pointerup`
   * 根本没派发到 document（指针在窗口外松开、窗口失焦被系统接管），那两个回调都不会来，
   * 标记会一直为真，之后所有写操作都不再刷新看板。把「没有拖拽在跑」与标记挂钩，
   * 无论哪条路径结束都能恢复。
   */
  useEffect(() => {
    if (drag.draggingTaskId === null) pointerActiveRef.current = false;
  }, [drag.draggingTaskId]);

  async function commitMove(taskId: string, columnId: string, position: number) {
    setActionError(null);
    const result = await actions.move(taskId, { columnId, position });
    if (!result.ok) {
      setActionError(result.message);
      // 静默重取可能也失败了，这里再响亮地取一次，保证界面回到服务端状态。
      board.reload();
    }
  }

  const closeEditor = useCallback(() => setEditing(null), []);
  const cancelCreate = useCallback(() => setCreatingColumnId(null), []);
  const clearSearch = useCallback(() => setKeyword(''), []);

  /**
   * 从结果行进入该任务的看板。
   *
   * 顺手清掉搜索词：留着搜索词的话，结果页会盖住刚打开的那一层，看起来像「点了没反应」。
   * 想回来再搜一次即可，代价比「进入后还要手动关掉搜索」小。
   */
  function openResult(taskId: string) {
    setKeyword('');
    onNavigate(taskId);
  }

  /**
   * 搜索框上的键盘动作。焦点始终在搜索框里，所以选中项的移动也在这里。
   * 顺带处理输入法：组合期间方向键在给候选词用、Enter 是确认选字，一律不接管。
   */
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) =>
        moveSelection(current, event.key === 'ArrowDown' ? 1 : -1, flatResults.length),
      );
      return;
    }
    if (event.key === 'Enter') {
      // preventDefault：否则选中的那一行按钮还会收到一次 click，等于进入两次。
      event.preventDefault();
      // 结果还没跟上输入框时什么都不做：那 200ms 里选中的是上一个关键词的结果，
      // 直接打开就是「搜乙却进了甲」。等结果回来再按一次即可。
      if (resultsAreStale) return;
      const result = flatResults[selectedIndex];
      if (result) openResult(result.id);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // stopPropagation：这一次 Esc 属于搜索框。抽屉的 Esc 监听挂在 document 上，
      // 而遮罩只盖住看板、不盖顶栏，所以抽屉开着时搜索框仍可聚焦——不拦住的话一次按键
      // 会同时清空搜索和关掉抽屉，抽屉里没保存的草稿直接丢掉。
      event.stopPropagation();
      clearSearch();
    }
  }

  async function saveTask(patch: TaskFieldsPatch): Promise<WriteResult> {
    if (editing === null) return { ok: false, message: '没有正在编辑的任务' };
    return actions.update(editing.id, patch);
  }

  /**
   * 抽屉里保存前置依赖。只有面板发现集合真的变了才会调到它
   * （判断在 TaskEditorPanel 的 depsNeedSave，那里才拿得到草稿）。
   */
  async function saveTaskDeps(predecessorIds: string[]): Promise<WriteResult> {
    if (editing === null) return { ok: false, message: '没有正在编辑的任务' };
    return actions.setDeps(editing.id, predecessorIds);
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
        search={{ keyword, onKeywordChange: setKeyword, onKeyDown: handleSearchKeyDown }}
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
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {actionError !== null && (
            // role="alert" 让读屏立刻播报（看板区没有别的地方会报这个错）。
            // 不再是 sticky：main 自己不再滚动，提示条是固定的一行，滚动的是它下面的内容区。
            <div
              role="alert"
              className="mx-4 mt-3 flex flex-none items-start gap-2 rounded-[5px] border border-line bg-surface px-2.5 py-1.5"
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
          {/*
            搜索态整块换成结果页（定版原型 C）。不依赖看板数据：结果页要的列名与列顺序
            由搜索响应自带（见 repositories/search.ts），所以当前这一层看板取不到时搜索照样能用。
            搜索态下不显示视图切换条：结果页占满主区，清空关键词就回到原来的视图。
          */}
          {searching ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <SearchResults
                state={search.state}
                groups={searchGroups}
                selectedIndex={selectedIndex}
                onOpen={openResult}
                onClear={clearSearch}
                onRetry={search.retry}
              />
            </div>
          ) : view === 'board' ? (
            <>
              <ViewToolbar view={view} onViewChange={setView} />
              {/*
                滚动容器从 main 挪到这一层：main 现在是「工具栏 + 内容区」的竖向布局，
                而看板列尾那片可落点要求滚动容器有确定高度（flex-1 + min-h-0 给得出），
                看板网格的 h-full 才能撑满、列尾的空白才属于列（见 BoardView 的注释与 D47）。
              */}
              <div className="min-h-0 flex-1 overflow-auto">
                {board.state.status === 'loading' && <LoadingNote />}
                {board.state.status === 'failed' && (
                  <ErrorNote message={board.state.message} onRetry={board.reload} />
                )}
                {board.state.status === 'ready' && (
                  <BoardView
                    board={board.state.data}
                    dragPreview={drag.preview}
                    dragSlot={dragSlot}
                    draggingTaskId={drag.draggingTaskId}
                    onOpenTask={(taskId) => {
                      // 拖完那一下浏览器仍会补一个 click，不拦就会顺手进入子看板。
                      if (drag.canOpen()) onNavigate(taskId);
                    }}
                    onEditTask={setEditing}
                    onSetArchived={setTaskArchived}
                    onDeleteTask={deleteTask}
                    onDragStart={(task, event) => {
                      // 按下就上标记：待定的点击期间也不该让静默重取换掉看板（那会重置这次拖拽）。
                      // begin 返回 false 表示这一次按下不会产生拖拽，标记不能留着自己不放。
                      if (drag.begin(task, event)) pointerActiveRef.current = true;
                    }}
                    create={create}
                  />
                )}
              </div>
            </>
          ) : (
            <DependencyGraph
              state={schedule.state}
              view={view}
              onViewChange={setView}
              showArchived={showArchived}
              // 列只用来给详情卡翻列名；看板还没到位时退化成 columnId，图本身不依赖它。
              columns={board.state.status === 'ready' ? board.state.data.columns : []}
              onOpenTask={(taskId) => {
                // 与「从搜索结果进入任务」同一个口径：进入后回到看板视图，
                // 否则刚打开的那一层会被依赖图盖着，看起来像「点了没反应」。
                setView('board');
                onNavigate(taskId);
              }}
              onRetry={schedule.reload}
            />
          )}
        </main>

        {editing !== null && (
          // key 用任务 id：换一个任务就整体重置表单草稿，不用写 effect 去同步 props。
          <TaskEditorPanel
            key={editing.id}
            task={editing}
            onClose={closeEditor}
            onSave={saveTask}
            dependency={{
              schedule: schedule.state,
              onRetry: schedule.reload,
              // 列只用来给候选分组查名字；候选任务本身来自依赖图的节点。
              columns: board.state.status === 'ready' ? board.state.data.columns : [],
              onSave: saveTaskDeps,
            }}
          />
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
