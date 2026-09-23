import type { ScheduleEdge, ScheduleNode } from '../api/types';

/**
 * 编辑某个任务的前置依赖时所需要的关系计算。
 *
 * 输入是 `GET /api/board[/:parentId]/cpm` 的边与任务字段，不碰网络也不碰组件，
 * 与 domain/board.ts、domain/search.ts 同一分工：能单独测的纯函数放这里。
 *
 * 前端算环而不只是把 409 显示出来，是因为「哪些候选能选」在点之前就该看得见：
 * 依赖是集合语义，用户很难自己记住整张图。
 */

/**
 * 会成环的候选行的禁用原因。后端对同一种情况回 409 `依赖形成环: <id>`
 * （apps/api/src/routes/tasks.ts）。这里换个说法：前端要让人在**点之前**就明白该去掉哪一项，
 * 只写「会形成环」等于把定位工作丢回给用户。
 */
export const CYCLE_BLOCKED_REASON = '会形成环：它已经依赖本任务';

/** 已归档任务的禁用原因。后端也会用 400 拒绝写入已归档的前置。 */
export const ARCHIVED_BLOCKED_REASON = '已归档';

/** 依赖编辑的初始状态：草稿、失效依赖的提示、每个候选能不能选。 */
export interface DependencyEditing {
  /**
   * 草稿的初始前置集合：当前前置里**未归档**的那些，按 id 升序（与后端响应的排序口径一致）。
   *
   * 已归档的前置不进来：后端会以 400 拒绝「前置含已归档任务」的整份提交，把它们留在草稿里
   * 会让这个任务的依赖永远存不下去。它们改由 `archivedPredecessorIds` 提示，保存时自然解除。
   */
  selectedIds: string[];
  /** 已归档、但仍作为前置挂在本任务上的任务。保存后这些依赖会被解除，界面要明说。 */
  archivedPredecessorIds: string[];
  /** 候选任务 id → 不能选的原因；可选的候选不在表里。 */
  blockedReasonById: Map<string, string>;
}

/**
 * 读出编辑 `taskId` 的依赖时要显示的状态。
 *
 * `tasks` 传这一层的全部任务（用 cpm 响应的 `nodes`），不是看板列里那些：
 * 归档任务在关着「显示已归档」时不在列里，但它们仍可能作为前置挂在本任务上，
 * 而且后端会拒绝把已归档任务写进依赖。用 nodes 才既认得出失效依赖、又标得出候选。
 * `edges` 同样必须是含归档任务的完整边集，否则可达集合会漏掉经过归档节点的环。
 */
export function readDependencyEditing(
  taskId: string,
  edges: readonly ScheduleEdge[],
  tasks: readonly { id: string; archivedAt: string | null }[],
): DependencyEditing {
  const predecessorIds = predecessorIdsOf(edges, taskId);
  const archivedIds = new Set(
    tasks.filter((task) => task.archivedAt !== null).map((task) => task.id),
  );
  const selectedIds: string[] = [];
  const archivedPredecessorIds: string[] = [];
  for (const id of predecessorIds) {
    if (archivedIds.has(id)) archivedPredecessorIds.push(id);
    else selectedIds.push(id);
  }

  const cyclic = successorClosure(edges, taskId);
  const blockedReasonById = new Map<string, string>();
  for (const task of tasks) {
    if (task.id === taskId) continue;
    if (task.archivedAt !== null) {
      blockedReasonById.set(task.id, ARCHIVED_BLOCKED_REASON);
    } else if (cyclic.has(task.id)) {
      blockedReasonById.set(task.id, CYCLE_BLOCKED_REASON);
    }
  }

  return { selectedIds, archivedPredecessorIds, blockedReasonById };
}

/** 某个任务当前的全部前置 id，升序。含已归档的前置——调用方自己决定怎么处理。 */
export function predecessorIdsOf(edges: readonly ScheduleEdge[], taskId: string): string[] {
  return edges
    .filter((edge) => edge.successorId === taskId)
    .map((edge) => edge.predecessorId)
    .sort();
}

/**
 * 从 `taskId` 出发、顺着 successor 方向能到达的所有任务 id（不含自己）。
 *
 * 新增 `candidate → task` 会成环，当且仅当 candidate 在这个集合里（它直接或间接依赖 task），
 * 与后端 repositories/deps.ts 的判定同源。用显式栈而不是递归：脏数据成环时也不会爆栈，
 * 而 `seen` 天然让遍历终止。
 */
export function successorClosure(edges: readonly ScheduleEdge[], taskId: string): Set<string> {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const list = next.get(edge.predecessorId);
    if (list === undefined) next.set(edge.predecessorId, [edge.successorId]);
    else list.push(edge.successorId);
  }

  const seen = new Set<string>();
  const stack = [...(next.get(taskId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const successor of next.get(current) ?? []) stack.push(successor);
  }
  // 自环（脏数据）时自己会落进 seen；调用方按 id 排除自己，这里不再特判。
  return seen;
}

/**
 * 两个依赖集合是否相同。按**集合**比，与顺序、重复项都无关：调用方拿它决定要不要发 PUT，
 * 而后端收到的那份会被去重再排序。重复项目前在界面上产生不了，但「集合比较」这件事本身
 * 不该依赖调用方的这份自觉——`['a','a']` 与 `['a','b']` 长度相同，逐项 includes 会误判成相同。
 */
export function sameDependencySet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  for (const id of leftSet) {
    if (!rightSet.has(id)) return false;
  }
  return true;
}

/** 候选列表里的一行。 */
export interface DependencyCandidateRow {
  id: string;
  title: string;
  durationMinutes: number | null;
  selected: boolean;
  /** 非 null 表示这一行不能勾选，文案就是这个原因。 */
  blockedReason: string | null;
}

/** 候选按列分组，组顺序与组内顺序都跟着 cpm 响应（后端已按列序 + 列内 orders 排好）。 */
export interface DependencyCandidateGroup {
  columnId: string;
  columnName: string;
  rows: DependencyCandidateRow[];
}

/**
 * 把整层的依赖图节点整理成候选列表：排除本任务自己，按列分组，标出已选与不能选的原因。
 *
 * `columns` 只用来查列名（节点自己只有 columnId）。节点顺序保持 cpm 响应的顺序，
 * 不按列名重排——后端给的顺序就是看板上的顺序，重排会让候选与卡片对不上。
 */
export function buildCandidateGroups(
  nodes: readonly ScheduleNode[],
  columns: readonly { id: string; name: string }[],
  taskId: string,
  blockedReasonById: ReadonlyMap<string, string>,
  selectedIds: readonly string[],
): DependencyCandidateGroup[] {
  const nameById = new Map(columns.map((column) => [column.id, column.name]));
  const selected = new Set(selectedIds);
  const groups: DependencyCandidateGroup[] = [];
  const groupByColumn = new Map<string, DependencyCandidateGroup>();

  for (const node of nodes) {
    if (node.id === taskId) continue;
    let group = groupByColumn.get(node.columnId);
    if (group === undefined) {
      group = {
        columnId: node.columnId,
        // 列名缺失只可能是看板数据比图旧（例如图先到）；退化成 id 也比丢掉整组强。
        columnName: nameById.get(node.columnId) ?? node.columnId,
        rows: [],
      };
      groupByColumn.set(node.columnId, group);
      groups.push(group);
    }
    group.rows.push({
      id: node.id,
      title: node.title,
      durationMinutes: node.durationMinutes,
      selected: selected.has(node.id),
      blockedReason: blockedReasonById.get(node.id) ?? null,
    });
  }

  return groups;
}

/**
 * 按标题过滤候选。空关键词原样返回——过滤只影响显示，不改已选集合，
 * 所以「已选 N 项」与保存时提交的集合都不受它影响（被过滤掉的已选项仍会被保存）。
 */
export function filterCandidateGroups(
  groups: readonly DependencyCandidateGroup[],
  keyword: string,
): DependencyCandidateGroup[] {
  const needle = keyword.trim().toLowerCase();
  if (needle === '') return [...groups];
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => row.title.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.rows.length > 0);
}
