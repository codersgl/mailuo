import { useEffect } from 'react';
import { usePersistentState } from '../hooks/usePersistentState';
import { useTree } from '../hooks/useTree';
import { COLLAPSED_TASKS_KEY } from '../lib/preferences';
import { ancestorIds, buildTree, expandAncestors, toggleCollapsed } from '../lib/tree';
import { ErrorNote, LoadingNote } from './StatusNote';
import { TreeNodeRow } from './TreeNodeRow';

/** 面板宽度取自定版原型 A：固定 252px、不可折叠。 */
const PANEL_WIDTH = 252;

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * 左侧文件树。点任务名进入该任务的看板；三角只负责展开折叠。
 * 归档是否出现在树里由后端的 `?includeArchived` 决定，开关本身由 BoardPage 持有
 * （看板列也要认同一个开关，见 docs/decisions.md D35），这里只做受控显示与回调。
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
  const { state, reload, refresh } = useTree(showArchived);

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
      aria-label="文件树"
      className="flex flex-none flex-col border-r border-line bg-surface"
      style={{ width: PANEL_WIDTH }}
    >
      <div className="flex flex-none items-center justify-between gap-2 border-b border-line py-[9px] pl-3 pr-2.5">
        <h2 className="text-[11.5px] font-semibold tracking-[0.3px] text-ink-2">文件树</h2>
        <label className="flex cursor-pointer items-center gap-1.5">
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1.5">
        {boardMissingFromTree && (
          <p className="px-2 py-1 text-[11px] text-ink-3">当前看板不在树里，可能已归档</p>
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
                  setCollapsedIds((collapsed) => toggleCollapsed(collapsed, taskId))
                }
                onOpen={onNavigate}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
