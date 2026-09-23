import type { TreeTask } from '../api/types';
import { DONE_COLUMN_ID } from '../domain/columns';

/** 任务树的一个节点：一个任务加它的子节点。 */
export interface TreeNode {
  task: TreeTask;
  children: TreeNode[];
}

/**
 * 把 `GET /api/tree` 的平铺列表变成嵌套树。
 * 后端按 `parent_id, orders` 排序，所以同一父节点下的顺序就是看板里的顺序，这里不再排序。
 */
export function buildTree(tasks: TreeTask[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const task of tasks) {
    nodes.set(task.id, { task, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id)!;
    const parent = task.parentId === null ? undefined : nodes.get(task.parentId);
    // 父节点不在本次结果里（父任务已归档而「显示已归档」关着）时按顶层处理：
    // 宁可多显示一个孤儿节点，也不要让任务在树里凭空消失。
    // 归档父节点下出现未归档的子任务只可能来自手工改库——后端归档的是整棵子树（D24）。
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * 从根到该节点父级的 id 链，用于「当前看板所在节点被折叠起来」时自动展开它。
 * 脏数据成环时（后端有守卫，手工改库才可能）用 visited 截断，避免死循环。
 */
export function ancestorIds(tasks: TreeTask[], taskId: string): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const chain: string[] = [];
  const visited = new Set<string>([taskId]);

  let current = byId.get(taskId);
  while (current && current.parentId !== null) {
    const parentId = current.parentId;
    if (visited.has(parentId)) break;
    visited.add(parentId);
    chain.unshift(parentId);
    current = byId.get(parentId);
  }
  return chain;
}

/**
 * 一个节点的直接子任务进度，口径与后端一致（见 docs/spec.md 的「状态语义」）：
 * 分母是未归档的直接子任务，分子是其中处于完成列的。归档子任务一律不计——
 * 打开「显示已归档」后树里多了归档节点，这一步过滤保证计数不变。
 *
 * 口径写了两遍（后端 `readBoard` 的 child_total/child_done 与这里）是眼下的取舍：
 * `GET /api/tree` 不返回计数，而树的徽标要就地显示，避免每层再拉一次看板接口。
 */
export function countChildren(node: TreeNode): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const child of node.children) {
    if (child.task.archivedAt !== null) continue;
    total += 1;
    if (child.task.columnId === DONE_COLUMN_ID) done += 1;
  }
  return { total, done };
}

/**
 * 折叠集合的开关。存的是「已折叠」的 id 而不是「已展开」的：默认全展开，
 * 第一次打开应用时整棵树是可见的，用户折叠过的节点才需要记住。
 */
export function toggleCollapsed(collapsed: string[], taskId: string): string[] {
  return collapsed.includes(taskId)
    ? collapsed.filter((id) => id !== taskId)
    : [...collapsed, taskId];
}

/** 把给定节点从折叠集合里去掉（用于自动展开当前看板的祖先）。没有变化时返回原数组。 */
export function expandAncestors(collapsed: string[], taskIds: string[]): string[] {
  const remaining = collapsed.filter((id) => !taskIds.includes(id));
  return remaining.length === collapsed.length ? collapsed : remaining;
}

/** 整棵树里某个节点的所有后代 id（不含自己）。成环的脏数据用 visited 截断。 */
export function descendantIds(tasks: TreeTask[], taskId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const bucket = children.get(task.parentId) ?? [];
    bucket.push(task.id);
    children.set(task.parentId, bucket);
  }

  const found = new Set<string>();
  const queue = [...(children.get(taskId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (found.has(current)) continue;
    found.add(current);
    queue.push(...(children.get(current) ?? []));
  }
  return found;
}

/**
 * 任务树拖动的落点，与看板列内的落点（domain/board.ts 的 DropSlot）不是一回事：
 * 树只改层级、不排序，所以落点只有「挂到某个节点下」和「挂到根下」两种。
 *
 * 悬停行的上/下半决定子级还是兄弟——与 B 版原型一致，也和多数树形视图工具的习惯一致。
 * `afterTaskId` 非空表示「放到这个节点之后、与它同级」，用于在界面上画一条插入线；
 * 落库时前端只发父级 id（后端一律追加到末尾），树本来就不支持排序。
 */
export interface TreeDrop {
  /** 新的父任务 id；null 表示挂到根看板下。 */
  parentId: string | null;
  /** 同级的插入锚点，仅用于界面提示。 */
  afterTaskId: string | null;
}

/**
 * 把「拖动的节点 + 指针悬停的行 + 指针在行的上半还是下半」换算成落点。
 * 返回 null 表示这里不能放：拖到自己或自己的后代下会成环，后端也会用 400 拒绝。
 *
 * 下半区一律是「与目标同级、排在它后面」——包括目标是顶层节点时（新父级为 null）。
 * 早期版本让顶层节点的下半区退化成「成为它的子节点」，于是「把 B 拖到 A 下面」会变成
 * 「把 B 拖进 A 里面」，与界面上画的插入线不是一回事（用例 `useTreeDrag` 抓到的）。
 */
export function resolveTreeDrop(
  tasks: TreeTask[],
  dragId: string,
  over: { id: string; lowerHalf: boolean },
): TreeDrop | null {
  if (over.id === dragId) return null;
  if (descendantIds(tasks, dragId).has(over.id)) return null;

  const target = tasks.find((task) => task.id === over.id);
  // 目标不在树里说明数据已经过期，宁可这一下落空，也不要凭 id 猜一个父级。
  if (target === undefined) return null;

  if (over.lowerHalf) {
    return { parentId: target.parentId, afterTaskId: target.id };
  }
  return { parentId: target.id, afterTaskId: null };
}
