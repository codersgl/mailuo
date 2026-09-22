import { useEffect } from 'react';
import { usePersistentState } from '../hooks/usePersistentState';
import { useTree } from '../hooks/useTree';
import { ancestorIds, buildTree, expandAncestors, toggleCollapsed } from '../lib/tree';
import { ErrorNote, LoadingNote } from './StatusNote';
import { TreeNodeRow } from './TreeNodeRow';

/** 面板宽度取自定版原型 A：固定 252px、不可折叠。 */
const PANEL_WIDTH = 252;

/** 本地偏好的 key。展开状态与开关都只存前端，不落库（见 docs/spec.md 的「归档」「界面行为」）。 */
const COLLAPSED_KEY = 'kanban.tree.collapsed';
const SHOW_ARCHIVED_KEY = 'kanban.tree.showArchived';

const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
/** 元素类型也要校验：`['a', 1]` 这类脏值会让 collapsedIds.includes 静默失效。 */
const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * 左侧文件树。点任务名进入该任务的看板；三角只负责展开折叠。
 * 归档是否出现在树里由后端的 `?includeArchived` 决定，这里的开关只负责把 query 传下去（D24）。
 */
export function Sidebar({
  boardId,
  onNavigate,
}: {
  /** 当前看板对应的任务 id；根看板为 null。 */
  boardId: string | null;
  onNavigate: (taskId: string) => void;
}) {
  const [showArchived, setShowArchived] = usePersistentState(SHOW_ARCHIVED_KEY, false, isBoolean);
  const [collapsedIds, setCollapsedIds] = usePersistentState<string[]>(
    COLLAPSED_KEY,
    [],
    isStringArray,
  );
  const { state, reload } = useTree(showArchived);

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
            onChange={(event) => setShowArchived(event.target.checked)}
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
