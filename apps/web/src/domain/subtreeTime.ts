import type { TreeTask } from '../api/types';
import { formatScheduleMinutes } from '../lib/format';
import { DONE_COLUMN_ID } from './columns';
import { elapsedSinceMinutes, NO_REMINDER, reminderFromTotals } from './reminder';
import type { ReminderView } from './reminder';

/**
 * 子树的时间汇总：算给「有子任务的父任务」用（见 docs/spec.md 的「工期提醒」）。
 *
 * 为什么不直接看父任务自己的两个字段：它不由用户拖动、列也由子任务推导，而且**不走表**
 * （api 的 domain/clock.ts 只让叶子计时）。所以它自己的 duration_minutes / spent_minutes
 * 都不是它的展示口径——拿它们画出来的进度条只会误导人（D76 就是把那条假条摘掉的）。
 * 它的口径是子树求和：
 *   已用 = Σ 子树里未归档叶子的已用
 *   工期 = Σ 子树里未归档叶子的工期；只要有一片叶子未估，就是「未估」
 * 两个和都是**工作量**口径，不是日历工期：叶子可以并行，Σ工期 不是「还要多久」。
 * 但它与 Σ已用 是同一把尺子，比值才是分支进度。分母不可信时不装出进度，只报
 * 「已用 X / 未估」（B 版原型，见 docs/decisions.md D77）。
 *
 * 已归档的整支不参与：归档任务整棵不显示，列与计时都留着原样（与后端对账同口径）。
 * 汇总是每次渲染从树上现算的，不落库也不缓存，所以「取消归档」之后这些数自己就回来了。
 *
 * 「已用」里正在跑的那一段不在这里算死：汇总只存 Σ已结算 与「哪几片叶子在跑」，
 * 具体分钟数由视图用自己的 now 现算（见 subtreeUsedMinutes）。父任务的进度条
 * 因此与叶子的进度条一起随时间走，而不是等下一次取数才跳一下。
 */

/** 一棵子树里未归档叶子的时间汇总。 */
export interface SubtreeTime {
  /** 未归档叶子的数量。0 表示没有可汇总的叶子（任务自己就是叶子，或整支已归档）。 */
  leafCount: number;
  /** Σ 未归档叶子**已结算**的用时，不含正在跑的那一段。 */
  spentMinutes: number;
  /** 此刻正在跑的叶子的开始时刻，每片一项；求和时各算各的一段再相加。 */
  runningSince: string[];
  /** Σ 未归档叶子工期；有叶子未估（null）时为 null。 */
  durationMinutes: number | null;
}

/** 一片叶子自己就是一条汇总：父任务的 leafCount 从 1 起，叶子是 0。 */
function leafPart(leaf: TreeTask): SubtreeTime {
  return {
    leafCount: 1,
    spentMinutes: leaf.spentMinutes,
    runningSince: leaf.runningSince === null ? [] : [leaf.runningSince],
    durationMinutes: leaf.durationMinutes,
  };
}

/**
 * 算出每个任务「子树里未归档叶子」的汇总。
 *
 * 返回的 Map 里没有任务自己的时间——一个任务自己的工期与已用是它自己的事，
 * 父任务要的是**下面那些叶子**加起来是多少。所以叶子的条目 leafCount 是 0。
 *
 * 用显式栈做后序遍历而不是递归：树有多深由用户决定，一条长链会把调用栈撑爆
 * （与 lib/tree.ts 的 descendantIds 不用递归是同一个理由）。
 */
export function buildSubtreeTimes(tasks: TreeTask[]): Map<string, SubtreeTime> {
  // 归档任务整支不参与，先排除；剩下的父子关系由 parentId 给出。
  const active = tasks.filter((task) => task.archivedAt === null);
  const allChildren = indexChildren(active);
  /**
   * 成环的任务（只有手工改库才可能）整批剔出去再汇总。
   *
   * 不剔的话结果会取决于从哪个节点开始遍历：环上那个「先被结算」的节点会把自己的汇总
   * 让给环上的另一个人（甲↔乙时，从甲出发乙就继承甲的汇总，从乙出发甲继承乙的），
   * 同一份数据两次渲染就能给出不同的数。剔掉之后剩下的是一张森林，遍历顺序不再影响结果。
   * 代价是挂在环下面的子树不再向上合并（它们各自成根）：环本身没有可定义的「子树里的叶子」。
   */
  const cyclic = findCycleMembers(active, allChildren);
  const childrenOf = indexChildren(active.filter((task) => !cyclic.has(task.id)));

  const sums = new Map<string, SubtreeTime>();
  for (const start of active) {
    if (cyclic.has(start.id) || sums.has(start.id)) continue;
    // 两阶段栈：enter 时把 leave 帧压回去，leave 时所有子节点都已经结算完。
    const stack: Array<{ task: TreeTask; phase: 'enter' | 'leave' }> = [
      { task: start, phase: 'enter' },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.phase === 'enter') {
        // 已结算过（换了一个起点时常见）就不要再算一遍。
        if (sums.has(frame.task.id)) continue;
        stack.push({ task: frame.task, phase: 'leave' });
        for (const child of childrenOf.get(frame.task.id) ?? []) {
          stack.push({ task: child, phase: 'enter' });
        }
        continue;
      }
      sums.set(frame.task.id, sumLeaves(childrenOf.get(frame.task.id) ?? [], allChildren, sums));
    }
  }
  return sums;
}

/** parentId -> 未归档子任务。没有子任务的 id 不会出现在里面，正是「叶子」的判据。 */
function indexChildren(tasks: TreeTask[]): Map<string, TreeTask[]> {
  const childrenOf = new Map<string, TreeTask[]>();
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
 *
 * 环只可能来自手工改库（接口层用 isSelfOrDescendant 挡住了），所以不需要多聪明的算法：
 * 逐个任务做一次可达性搜索，个人规模（几百个任务）下这点平方级开销可以忽略。
 */
function findCycleMembers(
  active: TreeTask[],
  childrenOf: Map<string, TreeTask[]>,
): Set<string> {
  const cyclic = new Set<string>();
  for (const start of active) {
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
 * 把一批子节点的汇总并成一个：子节点自己还是叶子就取它自己，否则取它下面的那一份。
 *
 * `own.length === 0` 这个判据来自 allChildren（含成环节点），与汇总是同一份数据，
 * 所以「谁是叶子」的口径与后端一致（后端 countActiveChildren 也是数未归档直接子任务）。
 */
function sumLeaves(
  children: TreeTask[],
  allChildren: Map<string, TreeTask[]>,
  sums: Map<string, SubtreeTime>,
): SubtreeTime {
  let leafCount = 0;
  let spentMinutes = 0;
  let durationMinutes = 0;
  let unestimated = false;
  const runningSince: string[] = [];

  for (const child of children) {
    const own = allChildren.get(child.id) ?? [];
    const part = own.length === 0 ? leafPart(child) : sums.get(child.id);
    // 林子里的每个子节点在 leave 时都已经算过；这条守卫只是让类型收窄，正常走不到。
    if (part === undefined) continue;

    leafCount += part.leafCount;
    spentMinutes += part.spentMinutes;
    runningSince.push(...part.runningSince);
    if (part.durationMinutes === null) unestimated = true;
    else durationMinutes += part.durationMinutes;
  }

  return {
    leafCount,
    spentMinutes,
    runningSince,
    durationMinutes: unestimated ? null : durationMinutes,
  };
}

/**
 * 汇总里此刻的已用分钟数：Σ已结算，加上每片在跑的叶子各自那一段。
 * 各片分别向下取整再相加，与一片叶子自己的算法逐字一致（domain/reminder.ts 的 elapsedSinceMinutes）。
 */
export function subtreeUsedMinutes(time: SubtreeTime, nowMs: number): number {
  let used = time.spentMinutes;
  for (const since of time.runningSince) used += elapsedSinceMinutes(since, nowMs);
  return used;
}

/** 父任务卡片与树行要画的东西。 */
export interface BranchView {
  /** 聚合胶囊文案，例如「已用 1 天 3 小时 / 未估」。 */
  capsule: string;
  /** 分母是否可信。false 时胶囊用虚线，与叶子「未估工期」同一种标记。 */
  estimated: boolean;
  /** 完整文案，用作 title 与可访问名字：胶囊上只放得下分数，明细只能靠它。 */
  detail: string;
  /** 与叶子共用形状的提醒。未估或工期为 0 时是「什么都不画」。 */
  reminder: ReminderView;
}

/** 判定要用到的任务字段。BoardTask 与 TreeTask 都满足这个形状。 */
export interface BranchTaskFacts {
  columnId: string;
  archivedAt: string | null;
}

/**
 * 算出父任务此刻该画的分支投入。
 *
 * 分母不可信（子树里有叶子未估工期）时只报已用，不画进度条也不给临近/超期：
 * 把未估叶子按 0 计进分母，会让比率随着这些叶子干活自己往上飘，那是另一种误导，
 * 与被摘掉的那条假进度条同一类问题（A 版原型，见 docs/decisions.md D77）。
 */
export function branchView(time: SubtreeTime, task: BranchTaskFacts, nowMs: number): BranchView {
  const used = subtreeUsedMinutes(time, nowMs);
  const duration = time.durationMinutes;
  const usedText = formatScheduleMinutes(used);
  const head = `子树 ${time.leafCount} 个未归档叶子：Σ已用 ${usedText}`;

  if (duration === null) {
    return {
      capsule: `已用 ${usedText} / 未估`,
      estimated: false,
      detail: `${head}；其中有叶子未估工期，没有可信的分母，所以不给进度。`,
      reminder: NO_REMINDER,
    };
  }

  // 0 与叶子的口径一致：瞬时任务没有可用的时间窗，只报数字不画条。
  const durationText = duration <= 0 ? '瞬时' : formatScheduleMinutes(duration);
  const base = reminderFromTotals({
    durationMinutes: duration,
    usedMinutes: used,
    running: time.runningSince.length > 0,
    done: task.columnId === DONE_COLUMN_ID,
    archived: task.archivedAt !== null,
  });
  const tail = base.note === null ? '' : `，${base.note}`;
  const detail = `${head}，Σ工期 ${durationText}（工作量口径：叶子可以并行，不等于日历工期）${tail}。`;

  return {
    capsule: `已用 ${usedText} / ${durationText}`,
    estimated: true,
    detail,
    // 要画条时把明细换成聚合口径的文案：条与小字的 title 都读它，不能只说「工期 / 已用」，
    // 那会让人以为是这个任务自己的两个数。不画条时原样返回，保住 NO_REMINDER 这个常量本身。
    reminder: base.fill === null ? base : { ...base, detail },
  };
}
