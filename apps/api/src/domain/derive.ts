import { DONE_COLUMN_ID, DOING_COLUMN_ID, TODO_COLUMN_ID } from './columns.js';

/**
 * 状态推导：有子任务的父任务，所在列完全由子任务决定（见 docs/spec.md 的「状态语义」）。
 *
 * 规则：
 *   有未归档子任务处在「进行中」 → 进行中
 *   否则未归档子任务全部完成     → 完成
 *   否则（有子任务，但既没干完、也没在干） → 待办
 *
 * 没有未归档子任务的任务是**叶子**，保留自己当前的列；只有叶子能被手动拖动。
 *
 * 为什么是「完全推导」而不是只加两条单向规则（子任务进行中就把祖先置为进行中、
 * 子任务全完成就把父任务置为完成）：单向规则下「父任务在进行中，但整棵子树没有任何任务
 * 在进行中」是一种可达状态——把子任务从「进行中」拖回「待办」就会出现，看板于是自相矛盾。
 * 完全推导是**子任务列的函数**，与操作历史无关，也就不存在这种残留状态。
 *
 * 代价说清：有子任务的父任务不能再手动拖列（路由层直接拒绝，见 routes/tasks.ts），
 * 它自己设的工期估算也不再参与提醒判定（前端不显示）。
 */

/**
 * 推导只需要这三个字段的快照。
 *
 * 调用方必须只传**未归档**任务（reconcileDerivedStatus 的查询里有这个条件）：归档任务不出现在
 * 看板上，它的列要原样留着——取消归档时才有依据——所以它既不当子任务，也不被推导。
 */
export interface DeriveNode {
  id: string;
  parentId: string | null;
  columnId: string;
}

/**
 * 算出每个任务的列，返回 `id -> columnId` 的完整映射（叶子映射到它自己当前的列）。
 * 调用方拿它跟当前列比对，只写变了的那几行。
 *
 * 实现是**迭代式后序遍历**（子节点先算完，父节点再根据子节点的推导结果定），不是递归：
 * 父子关系成环的手工脏数据在递归里会栈溢出。
 *
 * 环怎么收场：环上的任务一律**保留各自的列**（见下面的 locked）。环上没有保证可达的不动点
 * ——两节点互相当父时，把结果代回规则会来回翻（甲依赖乙、乙又依赖甲），所以不去迭代求不动点，
 * 而是让环整段退出推导。这样结果是确定的（与输入顺序无关），而且重复对账不再有任何写入，
 * 「状态一致时不写行」这条才在脏数据上也成立。
 */
export function deriveColumns(tasks: readonly DeriveNode[]): Map<string, string> {
  const known = new Set(tasks.map((task) => task.id));
  const roots = tasks.filter((task) => task.parentId === null || !known.has(task.parentId));

  const children = new Map<string, DeriveNode[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const siblings = children.get(task.parentId);
    if (siblings === undefined) {
      children.set(task.parentId, [task]);
    } else {
      siblings.push(task);
    }
  }

  /**
   * 起点＝父行不在本批里的任务（父行已归档、或父链指向不存在的 id）。
   * 后面还要补上「从任何起点都走不到」的节点：父子成环的脏数据里可能一个真正的根都没有，
   * 只从 roots 出发会让这些节点整块漏掉。补的那批按输入顺序处理，环在遍历中被识别出来锁掉。
   */
  const rootIds = new Set(roots.map((task) => task.id));
  const seeds = [...roots, ...tasks.filter((task) => !rootIds.has(task.id))];

  const derived = new Map<string, string>();
  const onStack = new Set<string>();
  /** 落在父子环上的任务：保留各自的列，不参与推导（理由见文件头）。 */
  const locked = new Set<string>();

  for (const seed of seeds) {
    if (derived.has(seed.id)) continue;

    const stack: Array<{ node: DeriveNode; nextChild: number }> = [{ node: seed, nextChild: 0 }];
    onStack.add(seed.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const kids = children.get(frame.node.id) ?? [];

      if (frame.nextChild < kids.length) {
        const child = kids[frame.nextChild]!;
        frame.nextChild += 1;
        if (onStack.has(child.id)) {
          // 回边：从 child 到栈顶这一段就是那个环，整段锁住。锁住的节点不再入栈，
          // 循环因此终止；它结算时用自己的列，父节点取到的也是一个确定的值。
          for (let index = stack.length - 1; index >= 0; index -= 1) {
            const member = stack[index]!.node.id;
            locked.add(member);
            if (member === child.id) break;
          }
          continue;
        }
        if (derived.has(child.id)) continue;
        onStack.add(child.id);
        stack.push({ node: child, nextChild: 0 });
        continue;
      }

      stack.pop();
      onStack.delete(frame.node.id);
      derived.set(frame.node.id, resolveColumn(frame.node, kids, derived, locked));
    }
  }

  return derived;
}

/** 单个任务的落点。叶子原样保留；有子任务时按子任务的推导结果定；环上的任务原样保留。 */
function resolveColumn(
  node: DeriveNode,
  children: readonly DeriveNode[],
  derived: Map<string, string>,
  locked: ReadonlySet<string>,
): string {
  if (locked.has(node.id)) return node.columnId;
  if (children.length === 0) return node.columnId;

  const childColumns = children.map((child) => derived.get(child.id) ?? child.columnId);
  if (childColumns.includes(DOING_COLUMN_ID)) return DOING_COLUMN_ID;
  if (childColumns.every((columnId) => columnId === DONE_COLUMN_ID)) return DONE_COLUMN_ID;
  return TODO_COLUMN_ID;
}
