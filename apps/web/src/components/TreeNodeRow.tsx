import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TreeTask } from '../api/types';
import { DONE_COLUMN_ID, DOING_COLUMN_ID } from '../domain/columns';
import { NO_REMINDER, reminderView } from '../domain/reminder';
import type { ReminderView } from '../domain/reminder';
import { branchView } from '../domain/subtreeTime';
import type { BranchView, SubtreeTime } from '../domain/subtreeTime';
import { cx } from '../lib/cx';
import { countChildren } from '../lib/tree';
import type { TreeNode } from '../lib/tree';
import type { TreeDragState } from '../hooks/useTreeDrag';
import { DurationBar } from './DurationBar';

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
  /** 当前时刻，节点上的工期进度条要它（见 hooks/useNow）。 */
  nowMs: number;
  /** 每个任务的子树时间汇总，父任务那一行用它（见 domain/subtreeTime.ts）。 */
  subtreeTimes: Map<string, SubtreeTime>;
  /** 这一层在树里的深度，从 0 开始，渲染成 data-tree-depth 供调试与验收脚本使用。 */
  depth: number;
}

/**
 * 任务树的一行：三角（展开折叠）+ 任务名（进入该任务的看板）+ 右侧状态。
 * 有子节点才画三角，叶子留一个同宽空位保持对齐，所以「有三角」本身就说明有子节点。
 * 子节点用嵌套的 ul 表达层级（缩进靠 ul 的 padding-left），不把层级压成缩进数值。
 *
 * 拖动这一行可以改父级，落点由上层换算（见 hooks/useTreeDrag）：
 * 悬停行上半区 = 成为它的子节点，下半区 = 与它同级（挂到它的父级下）。这里只负责把
 * 「这一行就是新父级」画出来；落点在根层时没有行可高亮，那种提示在 Sidebar 顶部。
 */
export function TreeNodeRow({
  node,
  selectedId,
  collapsedIds,
  onToggle,
  onOpen,
  onDragStart,
  drag,
  nowMs,
  subtreeTimes,
  depth,
}: TreeNodeRowProps) {
  const { task, children } = node;
  const selected = task.id === selectedId;
  const collapsed = collapsedIds.includes(task.id);
  const hasChildren = children.length > 0;
  const { total, done } = countChildren(node);
  const archived = task.archivedAt !== null;
  /**
   * 有未归档子任务的父任务画的是**子树聚合**，不是它自己的工期（与卡片同一条口径，见 D77）。
   * 判据用 `total` 而不是 `hasChildren`——前者只数未归档子任务，正是「叶子」的定义；
   * 一个只有归档子任务的节点是叶子，它的表照常走，提醒也该照常画。
   * 树里这两者是同一个来源（lib/tree.ts 的 countChildren），与看板的 childTotal 口径一致。
   */
  const subtree = subtreeTimes.get(task.id);
  const branch =
    total > 0 && subtree !== undefined && subtree.leafCount > 0
      ? branchView(subtree, task, nowMs)
      : null;
  const reminder =
    branch !== null ? branch.reminder : total === 0 ? reminderView(task, nowMs) : NO_REMINDER;

  const dragging = drag?.draggingId === task.id;
  /**
   * 这一行会不会成为新父级。下半区落到「与目标同级」时，进的是目标的父级那一行——
   * `drop.parentId` 就是它，所以两半共用这一个判断。落点在根层时没有任何一行是父级，
   * 那种情形由 Sidebar 顶部的落点提示表达（定版原型 B2）。
   */
  const isDropParent = drag !== null && drag.drop !== null && drag.drop.parentId === task.id;

  return (
    <li>
      <div
        data-tree-row={task.id}
        data-tree-depth={depth}
        className={cx(
          'relative flex h-[26px] cursor-grab items-center gap-1.5 rounded-[5px] py-0 pl-2 pr-2',
          // 三种文字颜色互斥地写成三条完整分支，不做「条件类叠加」：cx 只拼字符串、不去重，
          // 同一属性出现两次时谁生效由生成样式表的源序决定（见 docs/decisions.md D39）。
          selected
            ? 'bg-accent-weak font-semibold text-accent'
            : archived
              ? // 归档节点不只靠变灰：虚线边框 + 斜体「归档」标记，和普通节点一眼可分。
                'border border-dashed border-line-strong text-ink-3 hover:bg-track'
              : 'text-ink-2 hover:bg-track',
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

        {/*
          工期进度条放在标题与右侧状态之间：252px 的面板里放不下整条进度条，
          所以用一条 24×3 的小短条表示比例，完整文案（工期 / 已用 / 剩多久）放在 title 与
          可访问名字上。它不是装饰——这一行没有别的地方表达剩余工期。
        */}
        <RowStatus
          task={task}
          selected={selected}
          collapsed={collapsed}
          hasChildren={hasChildren}
          childCount={children.length}
          total={total}
          done={done}
          branch={branch}
          reminder={reminder}
        />
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
              nowMs={nowMs}
              subtreeTimes={subtreeTimes}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * 一行的右侧状态：工期条 / 父任务的聚合比例与「未估」/ 归档标记 / 子任务徽标（或叶子的列点）。
 *
 * 从 TreeNodeRow 里拆出来是为了压住它的圈复杂度（拆之前 36，上限 30，eslint 已报错）：
 * 这里全是互斥的「该画哪一个」，单独一个函数反而更好读。口径与卡片完全一致，
 * 差别只在空间：252px 放不下「已用 1 天 3 小时 / 1 天 4 小时」，所以只留比例，完整文案进 title。
 */
function RowStatus({
  task,
  selected,
  collapsed,
  hasChildren,
  childCount,
  total,
  done,
  branch,
  reminder,
}: {
  task: TreeTask;
  selected: boolean;
  collapsed: boolean;
  hasChildren: boolean;
  /** 直接子任务总数（含已归档），只用来算折叠徽标的 title。 */
  childCount: number;
  /** 未归档的直接子任务数；0 表示叶子。 */
  total: number;
  done: number;
  branch: BranchView | null;
  reminder: ReminderView;
}) {
  const archived = task.archivedAt !== null;
  // 有比例可读的前提是「分母可信且确实画了条」：这两个条件在 branch 里已经是同一条。
  const percent = branch?.reminder.fill != null ? `${branch.reminder.percent}%` : null;

  return (
    <>
      {/*
        工期条放在标题与右侧状态之间：252px 的面板里放不下整条进度条，
        所以用一条 24×3 的小短条表示比例，完整文案（工期 / 已用 / 剩多久）放在 title 与
        可访问名字上。它不是装饰——这一行没有别的地方表达剩余工期。
      */}
      {reminder.fill !== null && (
        <DurationBar
          fill={reminder.fill}
          percent={reminder.percent}
          detail={reminder.detail}
          accessible
          className="h-[3px] w-6 flex-none overflow-hidden rounded-[2px] bg-track"
        />
      )}

      {/* 父任务再补一个百分比：这是 252px 里读得出来的一半信息（定版原型 B）。
          超期时用危险色，与卡片上的小字同一套语言。 */}
      {percent !== null && (
        <span
          className={cx(
            'flex-none text-[10.5px] tabular-nums',
            branch?.reminder.noteKind === 'over' ? 'text-danger' : 'text-ink-3',
          )}
        >
          {percent}
        </span>
      )}

      {/* 分母不可信时不给比例，只标「未估」：与叶子未估工期的虚线标记同一种语言。 */}
      {branch !== null && !branch.estimated && (
        <span
          title={branch.detail}
          className="flex-none rounded-[4px] border border-dashed border-line-strong px-1 text-[10px] leading-[14px] text-ink-3"
        >
          未估
        </span>
      )}

      {archived && (
        <span className="flex-none rounded-[4px] border border-dashed border-line-strong px-1 text-[10px] italic leading-[14px] text-ink-3">
          归档
        </span>
      )}

      <RowBadge
        selected={selected}
        collapsed={collapsed}
        hasChildren={hasChildren}
        childCount={childCount}
        total={total}
        done={done}
        columnId={task.columnId}
      />
    </>
  );
}

/** 行尾那个徽标：折叠时是子任务数，展开且有子任务时是进度，叶子是一个表示所在列的点。 */
function RowBadge({
  selected,
  collapsed,
  hasChildren,
  childCount,
  total,
  done,
  columnId,
}: {
  selected: boolean;
  collapsed: boolean;
  hasChildren: boolean;
  childCount: number;
  total: number;
  done: number;
  columnId: string;
}) {
  if (collapsed && hasChildren) {
    return (
      <>
        <span className="flex-none text-[10px] leading-4 text-ink-3">已折叠</span>
        {/*
          数字与展开态用同一个口径（countChildren：只算未归档的直接子任务），否则打开
          「显示已归档」并折叠一个含归档子任务的节点时，会看到「5」与展开后的「3/5」并存，
          像是数据变了（审计报告 C6）。归档的那部分只在 title 里说明。
          `total > 0` 才画徽标：子任务全部已归档时展开态也没有徽标，折叠态显示「0」会是
          另一种不一致；那种情况留一行「已折叠」就够，三角本身就说明有子任务。
        */}
        {total > 0 && (
          <span
            className="flex-none rounded-lg border border-dashed border-line-strong px-[5px] text-center text-[11px] leading-[14px] tabular-nums text-ink-3"
            title={collapsedBadgeTitle(total, childCount - total)}
          >
            {total}
          </span>
        )}
      </>
    );
  }

  if (total > 0) {
    return (
      // 进度徽标口径见 lib/tree.ts 的 countChildren。
      <span
        className={cx(
          'min-w-4 flex-none rounded-lg px-[5px] text-center text-[11px] leading-4 tabular-nums',
          selected ? 'bg-surface text-accent' : done === total ? 'bg-accent-weak text-accent' : 'bg-track text-ink-2',
        )}
      >
        {done}/{total}
      </span>
    );
  }

  if (hasChildren) return null;

  // 叶子没有子任务就没有徽标，用一个点表示它在哪一列。
  return (
    <span
      role="img"
      aria-label={leafDotLabel(columnId)}
      title={leafDotLabel(columnId)}
      className={cx('size-1.5 flex-none rounded-full', leafDotClass(columnId))}
    />
  );
}

/**
 * 折叠徽标的 title。徽标上的数字只算未归档子任务（与展开态口径一致），
 * 有归档子任务时在这里补一句，免得用户以为子任务丢了。
 */
function collapsedBadgeTitle(activeChildren: number, archivedChildren: number): string {
  if (archivedChildren <= 0) return `有 ${activeChildren} 个子任务，当前已折叠`;
  return `有 ${activeChildren} 个子任务（另有 ${archivedChildren} 个已归档），当前已折叠`;
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
