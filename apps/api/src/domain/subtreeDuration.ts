/**
 * 父任务的工期：由子树里未归档叶子的工期加出来（见 docs/decisions.md D78）。
 *
 * 与前端 `apps/web/src/domain/subtreeTime.ts` 是同一口径的两份实现，这一点是有意的：
 * 前端那份要算「已用」（含此刻正在跑的那一段，只有前端知道用户的 now），这份只服务服务端的
 * 关键路径（CPM 要知道这一层每个节点占多长）。跨包没有共享代码的地方，而为一个纯函数造一个
 * 共享包不划算——与 `lib/tree.ts` 的 countChildren 重复后端 child_total 是同一类取舍。
 * 改口径时两份都要改，`apps/api/test/subtreeDuration.test.ts` 与
 * `apps/web/test/subtreeTime.test.ts` 用同一组夹具钉住同样的行为。
 *
 * 规则：
 * - 叶子（没有未归档子任务）不在表里，调用方用任务自己的 `duration_minutes`。
 * - 有未归档子任务的任务：Σ 未归档叶子工期；**只要有一片叶子未估就是 null**（与卡片一致）。
 * - 已归档的整支不参与（调用方只把未归档任务传进来）。
 *
 * 成环的脏数据（只有手工改库才可能）先把环上那几个任务整批剔出去：不剔的话结果取决于从哪个
 * 节点开始遍历，同一份数据两次读取能给出不同的数（与前端同一处理，理由见 D77）。
 */

/** 汇总需要的字段。调用方传进来的必须是**未归档**任务。 */
export interface DurationNode {
  id: string;
  parentId: string | null;
  durationMinutes: number | null;
}

/**
 * 算出每个「有未归档子任务」的任务的工期。返回的 Map 里没有叶子与已归档任务的条目。
 */
export function subtreeLeafDurations(tasks: DurationNode[]): Map<string, number | null> {
  const allChildren = indexChildren(tasks);
  const cyclic = findCycleMembers(tasks, allChildren);
  const childrenOf = indexChildren(tasks.filter((task) => !cyclic.has(task.id)));

  const sums = new Map<string, number | null>();
  for (const start of tasks) {
    if (cyclic.has(start.id) || sums.has(start.id)) continue;
    // 两阶段栈的后序遍历：enter 时把 leave 帧压回去，leave 时子节点都已算完。
    // 用显式栈而不是递归——树有多深由用户决定，一条长链会把调用栈撑爆。
    const stack: Array<{ id: string; phase: 'enter' | 'leave' }> = [
      { id: start.id, phase: 'enter' },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.phase === 'enter') {
        if (sums.has(frame.id)) continue;
        stack.push({ id: frame.id, phase: 'leave' });
        for (const child of childrenOf.get(frame.id) ?? []) {
          stack.push({ id: child.id, phase: 'enter' });
        }
        continue;
      }
      const children = childrenOf.get(frame.id) ?? [];
      // 叶子（没有未归档子任务）不进表：调用方要用它自己那个 duration_minutes。
      // 少了这一句，每片叶子都会在表里留下一个 0，调用方就会把它们的工期全当成 0。
      if (children.length === 0) continue;
      sums.set(frame.id, sumLeaves(children, allChildren, sums));
    }
  }
  return sums;
}

/** parentId -> 未归档子任务。没有子任务的 id 不会出现在里面，正是「叶子」的判据。 */
function indexChildren(tasks: DurationNode[]): Map<string, DurationNode[]> {
  const childrenOf = new Map<string, DurationNode[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const bucket = childrenOf.get(task.parentId);
    if (bucket === undefined) childrenOf.set(task.parentId, [task]);
    else bucket.push(task);
  }
  return childrenOf;
}

/**
 * 父子关系成环的任务集合：从某个任务出发能沿 parentId 再走回它自己的，就是环上的。
 * 环只可能来自手工改库（接口层挡住了），所以逐个任务做一次可达性搜索就够。
 */
function findCycleMembers(
  tasks: DurationNode[],
  childrenOf: Map<string, DurationNode[]>,
): Set<string> {
  const cyclic = new Set<string>();
  for (const start of tasks) {
    const seen = new Set<string>([start.id]);
    const stack = (childrenOf.get(start.id) ?? []).map((child) => child.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === start.id) {
        cyclic.add(start.id);
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of childrenOf.get(id) ?? []) stack.push(child.id);
    }
  }
  return cyclic;
}

/**
 * 把一批子节点并成一个和：子节点自己还是叶子就取它自己的工期，否则取已经算好的那一份。
 * `own.length` 用的是含成环节点的 allChildren——「谁是叶子」的口径与后端其它地方一致
 * （countActiveChildren 也是数未归档直接子任务）。
 */
function sumLeaves(
  children: DurationNode[],
  allChildren: Map<string, DurationNode[]>,
  sums: Map<string, number | null>,
): number | null {
  let total = 0;
  for (const child of children) {
    const own = allChildren.get(child.id) ?? [];
    const part = own.length === 0 ? child.durationMinutes : sums.get(child.id);
    // 只是给类型收窄：环是封闭的（每个任务只有一个 parentId，环里的人不可能同时挂在环外），
    // 所以非环的子节点在 leave 时都已经算过，正常走不到这里。
    if (part === undefined) continue;
    if (part === null) return null;
    total += part;
  }
  return total;
}
