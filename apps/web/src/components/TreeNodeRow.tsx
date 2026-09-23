import type { PointerEvent as ReactPointerEvent } from 'react';
import { DONE_COLUMN_ID, DOING_COLUMN_ID } from '../domain/columns';
import { cx } from '../lib/cx';
import { countChildren } from '../lib/tree';
import type { TreeNode } from '../lib/tree';
import { TREE_ROW_ATTR } from '../hooks/useTreeDrag';
import type { TreeDragState } from '../hooks/useTreeDrag';

interface TreeNodeRowProps {
  node: TreeNode;
  /** 当前看板对应的任务 id；根看板为 null，此时树里没有选中项。 */
  selectedId: string | null;
  collapsedIds: string[];
  onToggle: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onDragStart: (taskId: string, event: ReactPointerEvent<HTMLElement>) => void;
  /** 拖拽状态；null 表示当前没有在拖。 */
  drag: TreeDragState | null;
  /** 这一层在树里的深度，从 0 开始。测试与调试用它断言层级真的变了。 */
  depth: number;
}

/**
 * 文件树的一行：三角（展开折叠）+ 任务名（进入该任务的看板）+ 右侧状态。
 * 有子节点才画三角，叶子留一个同宽空位保持对齐，所以「有三角」本身就说明有子节点。
 * 子节点用嵌套的 ul 表达层级（缩进靠 ul 的 padding-left），不把层级压成缩进数值。
 *
 * 拖动这一行可以改父级，落点由上层换算（见 hooks/useTreeDrag）：
 * 悬停行上半区 = 成为它的子节点，下半区 = 排到它后面成为兄弟。这里只负责把提示画出来。
 */
export function TreeNodeRow({
  node,
  selectedId,
  collapsedIds,
  onToggle,
  onOpen,
  onDragStart,
  drag,
  depth,
}: TreeNodeRowProps) {
  const { task, children } = node;
  const selected = task.id === selectedId;
  const collapsed = collapsedIds.includes(task.id);
  const hasChildren = children.length > 0;
  const { total, done } = countChildren(node);
  const archived = task.archivedAt !== null;

  const dragging = drag?.draggingId === task.id;
  const dropParentId = drag?.drop?.parentId ?? null;
  const isDropParent = drag !== null && drag.drop !== null && dropParentId === task.id;
  const isDropSibling = drag?.drop?.afterTaskId === task.id;

  return (
    <li>
      <div
        {...{ [TREE_ROW_ATTR]: task.id }}
        data-tree-depth={depth}
        data-tree-parent={task.parentId ?? ''}
        className={cx(
          'relative flex h-[26px] cursor-grab items-center gap-1.5 rounded-[5px] py-0 pl-2 pr-2',
          selected ? 'bg-accent-weak font-semibold text-accent' : 'text-ink-2 hover:bg-track',
          // 归档节点不只靠变灰：虚线边框 + 斜体「归档」标记，和普通节点一眼可分。
          // 选中时让位：text-ink-3 与 text-accent 同时命中同一个元素时，生成 CSS 里 ink-3 在后，
          // 会把选中态的文字颜色吃掉（只剩背景色）。「归档」标记本身不受影响，仍然显示。
          archived && !selected && 'border border-dashed border-line-strong text-ink-3',
          // 拖动中的节点变淡；候补父级整行高亮（底色同选中态，靠左边的强调色竖条区分）。
          dragging && 'opacity-40',
          isDropParent && 'bg-accent-weak',
        )}
        onPointerDown={(event) => onDragStart(task.id, event)}
      >
        {(selected || isDropParent) && (
          <span
            className="absolute bottom-1 left-0 top-1 w-[2px] rounded-[1px] bg-accent"
            aria-hidden="true"
          />
        )}

        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(task.id)}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? '展开' : '折叠'}「${task.title}」`}
            className={cx(
              'grid size-3.5 flex-none place-items-center rounded-[3px] hover:bg-track',
              selected ? 'text-accent' : 'text-ink-3',
            )}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {collapsed ? <path d="M4.5 3 7.5 6 4.5 9" /> : <path d="M3 4.5 6 7.5 9 4.5" />}
            </svg>
          </button>
        ) : (
          <span className="size-3.5 flex-none" aria-hidden="true" />
        )}

        <button
          type="button"
          onClick={() => onOpen(task.id)}
          aria-current={selected ? 'page' : undefined}
          className="min-w-0 flex-1 truncate text-left text-[12.5px]"
        >
          {task.title}
        </button>

        {archived && (
          <span className="flex-none rounded-[4px] border border-dashed border-line-strong px-1 text-[10px] italic leading-[14px] text-ink-3">
            归档
          </span>
        )}

        {collapsed && hasChildren ? (
          <>
            <span className="flex-none text-[10px] leading-4 text-ink-3">已折叠</span>
            <span
              className="flex-none rounded-lg border border-dashed border-line-strong px-[5px] text-center text-[11px] leading-[14px] tabular-nums text-ink-3"
              title={`有 ${children.length} 个子任务，当前已折叠`}
            >
              {children.length}
            </span>
          </>
        ) : total > 0 ? (
          // 进度徽标口径见 lib/tree.ts 的 countChildren。
          <span
            className={cx(
              'min-w-4 flex-none rounded-lg px-[5px] text-center text-[11px] leading-4 tabular-nums',
              selected
                ? 'bg-surface text-accent'
                : done === total
                  ? 'bg-accent-weak text-accent'
                  : 'bg-track text-ink-2',
            )}
          >
            {done}/{total}
          </span>
        ) : !hasChildren ? (
          // 叶子没有子任务就没有徽标，用一个点表示它在哪一列。
          <span
            role="img"
            aria-label={leafDotLabel(task.columnId)}
            title={leafDotLabel(task.columnId)}
            className={cx('size-1.5 flex-none rounded-full', leafDotClass(task.columnId))}
          />
        ) : null}

        {/* 「排到它后面成为兄弟」的插入线：贴在这一行的下缘。 */}
        {isDropSibling && (
          <span
            data-tree-line
            className="pointer-events-none absolute inset-x-0 -bottom-[1px] h-0.5 rounded-[1px] bg-accent"
            aria-hidden="true"
          />
        )}
      </div>

      {hasChildren && !collapsed && (
        <ul className="pl-3.5">
          {children.map((child) => (
            <TreeNodeRow
              key={child.task.id}
              node={child}
              selectedId={selectedId}
              collapsedIds={collapsedIds}
              onToggle={onToggle}
              onOpen={onOpen}
              onDragStart={onDragStart}
              drag={drag}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function leafDotClass(columnId: string): string {
  if (columnId === DONE_COLUMN_ID) return 'bg-accent';
  if (columnId === DOING_COLUMN_ID) return 'bg-accent-border ring-1 ring-accent ring-inset';
  return 'ring-1 ring-line-strong ring-inset';
}

function leafDotLabel(columnId: string): string {
  if (columnId === DONE_COLUMN_ID) return '已完成';
  if (columnId === DOING_COLUMN_ID) return '进行中';
  return '待办';
}
