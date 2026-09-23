import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, changeTaskParent } from '../api/client';
import { usePersistentState } from '../hooks/usePersistentState';
import { useTree } from '../hooks/useTree';
import { useTreeDrag } from '../hooks/useTreeDrag';
import { COLLAPSED_TASKS_KEY, TREE_COLLAPSED_KEY } from '../lib/preferences';
import { ancestorIds, buildTree, expandAncestors, toggleCollapsed } from '../lib/tree';
import { ErrorNote, LoadingNote } from './StatusNote';
import { TreeNodeRow } from './TreeNodeRow';

/** 展开时的面板宽度，取自定版原型 A。 */
const PANEL_WIDTH = 252;
/**
 * 收起后的窄条宽度。只放得下一个 22px 的展开按钮与两侧留白，
 * 比展开态窄 208px，长看板下等于多出一列卡片的位置。
 */
const RAIL_WIDTH = 44;

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isBoolean = (value: unknown): boolean => typeof value === 'boolean';

/**
 * 左侧文件树。点任务名进入该任务的看板；三角只负责展开折叠。
 * 归档是否出现在树里由后端的 `?includeArchived` 决定，开关本身由 BoardPage 持有
 * （看板列也要认同一个开关，见 docs/decisions.md D35），这里只做受控显示与回调。
 *
 * 整个面板的收起/展开是这一层自己的事：顶栏、看板都不需要知道，收起只是把宽度让出去。
 */
export function Sidebar({
  boardId,
  onNavigate,
  showArchived,
  onShowArchivedChange,
  refreshToken,
}: {
  /** 当前看板对应的任务 id；根看板为 null。 */
  boardId: string | null;
  onNavigate: (taskId: string) => void;
  showArchived: boolean;
  onShowArchivedChange: (showArchived: boolean) => void;
  /** 写操作成功后由上层加一，用来让树静默重取一次（树的数据获取仍在 Sidebar 内部）。 */
  refreshToken: number;
}) {
  const [collapsedIds, setCollapsedIds] = usePersistentState<string[]>(
    COLLAPSED_TASKS_KEY,
    [],
    isStringArray,
  );
  // 面板收起：默认展开，坏掉的本地值（不是 boolean）按默认算（与「显示已归档」同一套兜底）。
  const [collapsed, setCollapsed] = usePersistentState(TREE_COLLAPSED_KEY, false, isBoolean);
  const { state, reload, refresh } = useTree(showArchived);
  const [dragError, setDragError] = useState<string | null>(null);

  const tasks = state.status === 'ready' ? state.data : [];

  /**
   * 落定一次树拖动。新父级下挂到哪一列由后端决定（追加到该列末尾），这里只把任务当前所在列带过去，
   * 所以这一步只换层级、不换列。成功后只重取树：改父级不影响当前看板的卡片与面包屑。
   */
  const commitParentChange = useCallback(
    async (taskId: string, parentId: string | null) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) return;
      setDragError(null);
      try {
        await changeTaskParent(taskId, { parentId, columnId: task.columnId });
        refresh();
      } catch (cause: unknown) {
        setDragError(cause instanceof ApiError ? cause.message : '移动任务失败');
      }
    },
    [tasks, refresh],
  );

  const treeDrag = useTreeDrag({
    tasks,
    onStart: () => setDragError(null),
    onDrop: (taskId, drop) => {
      if (drop === null) return;
      void commitParentChange(taskId, drop.parentId);
    },
    onCancel: () => {},
  });

  /**
   * 收起后树整块从 DOM 里消失，如果焦点当时在树里（键盘用户选中了一个节点），
   * 焦点会掉回 body，下一次 Tab 从头开始、方向键也没了目标。所以收起时把焦点交给那个按钮。
   *
   * 只在「收起」时抢焦点，不写进点击处理函数：键盘之外还有 StorageEvent 之类的来源，
   * 但更要紧的是这样不会在首次挂载（本地存的本来就是收起）时抢走用户的焦点——
   * 这条 effect 只跑在 collapsed 真正变化之后。
   */
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (collapsed) toggleRef.current?.focus();
  }, [collapsed]);

  // 写操作（新建、改名、归档、删除）之后树必须是新的：D34 遗留的那条「写操作那一步必须显式刷新树」。
  // 0 是初始值，挂载时不用多取一次。
  useEffect(() => {
    if (refreshToken === 0) return;
    refresh();
  }, [refreshToken, refresh]);

  // 当前看板的节点若被折叠在某个祖先里，用户就看不到自己在哪：自动展开那一条祖先链。
  // 只展开祖先、不展开自己，否则会覆盖用户「把这一支折起来」的操作。
  useEffect(() => {
    if (boardId === null || state.status !== 'ready') return;
    setCollapsedIds((collapsed) => expandAncestors(collapsed, ancestorIds(state.data, boardId)));
  }, [boardId, state, setCollapsedIds]);

  const roots = state.status === 'ready' ? buildTree(state.data) : [];
  // 直接打开一个已归档任务的看板（手输地址或书签）时，开关关着的话树里没有它，
  // 用户会看到一棵没有任何选中项的树；给一行说明，别让他自己猜。
  const boardMissingFromTree =
    state.status === 'ready' &&
    boardId !== null &&
    !state.data.some((task) => task.id === boardId);

  return (
    <aside
      aria-label={collapsed ? '文件树（已收起）' : '文件树'}
      // width 走过渡：收起/展开时看板是挤过去而不是跳过去，用户能看清是哪一块变窄了。
      // 收起态只留窄条，所以 transition 结束时布局与「一开始就是收起的」完全一致。
      className="flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150"
      style={{ width: collapsed ? RAIL_WIDTH : PANEL_WIDTH }}
    >
      <div
        className={
          collapsed
            ? 'flex flex-none justify-center border-b border-line py-[9px]'
            : 'flex flex-none flex-col border-b border-line px-3 py-[9px]'
        }
      >
        <div className="flex items-center justify-between gap-2">
          {/*
            收起时标题藏起来（窄条放不下），但按钮要留在同一个位置、同一个热区大小，
            所以标题用 sr-only 而不是不渲染：按钮的可访问名字仍能读成「收起文件树」。
          */}
          <h2
            className={
              collapsed
                ? 'sr-only'
                : 'text-[11.5px] font-semibold tracking-[0.3px] text-ink-2'
            }
          >
            文件树
          </h2>
          <CollapseToggle
            toggleRef={toggleRef}
            collapsed={collapsed}
            onToggle={() => setCollapsed(!collapsed)}
          />
        </div>
        {!collapsed && (
          <label className="mt-[7px] flex cursor-pointer items-center gap-1.5">
            {/* 用 sr-only 的原生 checkbox 而不是自绘按钮：键盘可达、有无障碍名称，样式交给后面的 span。 */}
            <input
              type="checkbox"
              className="peer sr-only"
              checked={showArchived}
              onChange={(event) => onShowArchivedChange(event.target.checked)}
            />
            <span
              className="relative h-[15px] w-[26px] flex-none rounded-full bg-line-strong after:absolute after:left-0.5 after:top-0.5 after:size-[11px] after:rounded-full after:bg-surface peer-checked:bg-accent peer-checked:after:left-[13px] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent-border"
              aria-hidden="true"
            />
            <span className="whitespace-nowrap text-[11px] text-ink-3">显示已归档</span>
          </label>
        )}
      </div>

      {/*
        树用 `hidden` 藏起来，而不是从 DOM 里拿掉。
        取中理由：`hidden` 是 display:none，树照样离开无障碍树与 Tab 顺序（收起后不会有人在
        读屏里读到一棵看不见的树），同时 React 不卸载它，展开时立刻就有内容。
        卸载的代价实测过：每次展开都会重新发一次 /api/tree，网络往返期间窄条里先空一下，
        这么高频的开关不该带一次请求。收起时那次挂载请求留着（见 D46 的取舍）。
      */}
      <div
        hidden={collapsed}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1.5"
      >
        {boardMissingFromTree && (
          <p className="px-2 py-1 text-[11px] text-ink-3">当前看板不在树里，可能已归档</p>
        )}
        {dragError !== null && (
          // 拖动的错误没有表单可以就地报错，在树顶上给一行，点一下就收起。
          <button
            type="button"
            onClick={() => setDragError(null)}
            className="mb-1 block w-full rounded-[5px] border border-line bg-surface px-2 py-1 text-left text-[11px] text-danger hover:border-line-strong"
          >
            {dragError}
          </button>
        )}
        {state.status === 'loading' && <LoadingNote />}
        {state.status === 'failed' && <ErrorNote message={state.message} onRetry={reload} />}
        {state.status === 'ready' && roots.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-ink-3">暂无任务</p>
        )}
        {state.status === 'ready' && roots.length > 0 && (
          <ul>
            {roots.map((node) => (
              <TreeNodeRow
                key={node.task.id}
                node={node}
                selectedId={boardId}
                collapsedIds={collapsedIds}
                onToggle={(taskId) =>
                  setCollapsedIds((ids) => toggleCollapsed(ids, taskId))
                }
                onOpen={(taskId) => {
                  // 拖完那一下浏览器仍会补一个 click，不拦就会顺手进入它的看板。
                  if (treeDrag.canOpen()) onNavigate(taskId);
                }}
                onDragStart={treeDrag.begin}
                drag={treeDrag.state}
                depth={0}
              />
            ))}
          </ul>
          )}
        </div>
    </aside>
  );
}

/**
 * 面板收起/展开按钮。图标是一块面板加一个指向内侧的箭头：箭头指向「点下去树会往哪走」，
 * 收起时指向右（收进窄条），展开时指向左（推出来）。
 *
 * aria-expanded 表达的是「它控制的那块内容是否可见」，所以收起时是 false —— 与图标方向相反是正常的。
 *
 * `toggleRef` 而不是 `ref`：收起时要由 Sidebar 把焦点从被移除的树上接到这个按钮，
 * 用普通 prop 传 ref，避免组件再依赖 React 19 才有的 ref-as-prop 写法。
 */
function CollapseToggle({
  toggleRef,
  collapsed,
  onToggle,
}: {
  toggleRef: React.RefObject<HTMLButtonElement | null>;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? '展开文件树' : '收起文件树';
  return (
    <button
      ref={toggleRef}
      type="button"
      aria-expanded={!collapsed}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className="grid size-[22px] flex-none place-items-center rounded-[5px] text-ink-3 hover:bg-track hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
        <path d="M6.25 2.75v10.5" />
        <path d={collapsed ? 'M8.75 6.25 10.5 8l-1.75 1.75' : 'M10.5 6.25 8.75 8l1.75 1.75'} />
      </svg>
    </button>
  );
}
