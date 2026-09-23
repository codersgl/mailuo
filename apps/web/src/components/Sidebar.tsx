import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, changeTaskParent } from '../api/client';
import { usePersistentState } from '../hooks/usePersistentState';
import { useNow } from '../hooks/useNow';
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
 * 左侧任务树。点任务名进入该任务的看板；三角只负责展开折叠。
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
  /** 收起按钮的 aria-controls 要指向被它控制的那块。用 useId 而不是写死字符串：写死的话
   *  同一个页面里出现第二个 Sidebar（例如将来的分屏）就会撞 id。 */
  const panelId = useId();
  const { state, reload, refresh } = useTree(showArchived);
  const [dragError, setDragError] = useState<string | null>(null);
  // 树节点上的工期进度条会随时间变档。与看板各挂一个 tick：两个视图各自渲染自己的那份数据，
  // 共用一个会让其中一边在另一边的重渲染里白跑（见 hooks/useNow）。
  const nowMs = useNow();

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
   * 收起时，如果焦点在树里（键盘用户选中了一个节点），树一变成 display:none 焦点就掉回 body，
   * 下一次 Tab 从页面开头重来、读屏用户也会发现自己「丢」了位置。所以收起的那一次把焦点接到按钮上。
   *
   * 只在 false → true 这一跳里聚焦，用 ref 记住上一次的值：effect 的依赖数组挂载时也会跑，
   * 只看 `collapsed` 的话，「本地存的就是收起」的首屏会去抢用户焦点（曾实测到，见 D46）。
   * 也正因如此不把 focus 写进点击处理函数：那样键盘之外的来源（StorageEvent 等）就漏了。
   */
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    if (collapsed && !wasCollapsed.current) toggleRef.current?.focus();
    wasCollapsed.current = collapsed;
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
      // 名字固定不随状态变：状态已经由按钮的 aria-expanded 表达，可访问名字保持稳定是惯例。
      aria-label="任务树"
      // width 走过渡：收起/展开时看板是挤过去而不是跳过去，用户能看清是哪一块变窄了。
      // 收起态只留窄条，所以 transition 结束时布局与「一开始就是收起的」完全一致。
      //
      // overflow-hidden 是过渡期的裁剪：展开的那几帧里盒子还是 44px 宽，而展开态的内容
      // （「显示已归档」有 whitespace-nowrap、树容器 overflow-y-auto 会把横向也算成 auto）
      // 已经渲染出来了，不裁的话标题会被逐字换行、文字和多出来的滚动条会画到看板列上
      // （审阅实测首帧 aside 宽 44 而内容宽 99）。按钮距面板边缘 11px，聚焦环不会被剪到。
      className="flex flex-none flex-col overflow-hidden border-r border-line bg-surface transition-[width] duration-150"
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
            收起时标题藏到 sr-only（窄条放不下可见的标题），收益是标题导航里仍然留着「任务树」。
            按钮的名字不依赖它：按钮自己带 aria-label。
          */}
          <h2
            className={
              collapsed
                ? 'sr-only'
                : 'text-[11.5px] font-semibold tracking-[0.3px] text-ink-2'
            }
          >
            任务树
          </h2>
          <CollapseToggle
            toggleRef={toggleRef}
            panelId={panelId}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
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
        id={panelId}
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
                nowMs={nowMs}
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
 * aria-expanded 表达的是「它控制的那块内容是否可见」，所以收起时是 false —— 与图标方向相反是正常的；
 * aria-controls 指向被控制的树容器，读屏用户可以从按钮直接跳到那块内容。
 *
 * `toggleRef` 而不是 `ref`：收起时 Sidebar 要用它把焦点接到这个按钮上，走普通 prop 比
 * 依赖 ref 转发更直白，也不需要给这个内部组件声明 forwardRef。
 */
function CollapseToggle({
  toggleRef,
  panelId,
  collapsed,
  onToggle,
}: {
  toggleRef: React.RefObject<HTMLButtonElement | null>;
  panelId: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? '展开任务树' : '收起任务树';
  return (
    <button
      ref={toggleRef}
      type="button"
      aria-expanded={!collapsed}
      aria-controls={panelId}
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
