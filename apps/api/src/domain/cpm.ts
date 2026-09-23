/**
 * 关键路径法（CPM，Critical Path Method）的纯计算：任务为顶点，依赖为有向边
 * （见 docs/spec.md 的「关键路径」与「依赖图可视化」）。
 * 不碰数据库，输入输出都是普通对象，可以单独测（与 domain/duration.ts、domain/search.ts 同一分工）。
 *
 * 口径：
 * - 工期单位是分钟整数；`null`（未估工期）按 0 参与计算，原值不在这一层保留——调用方拿到的
 *   是算好的时间，界面要提示「未估」得看任务记录自己的 durationMinutes。
 * - 不引入 AOE 的事件顶点表：AOE 要求单源单汇，而个人规划里多起点多终点是常态，
 *   所以项目总工期取所有任务最早完成时间的最大值。
 * - `slack = 最晚开始 - 最早开始`，slack 为 0 的任务构成关键路径。
 * - 全程整数加减，不做浮点比较。
 */

/** 参与计算的一个任务。 */
export interface ScheduleNodeInput {
  id: string;
  /** 工期分钟数；null 表示未估，按 0 计算。 */
  durationMinutes: number | null;
}

/** 一条依赖：predecessor 完成后 successor 才能开始。 */
export interface ScheduleEdgeInput {
  predecessorId: string;
  successorId: string;
}

/** 一个任务的时间参数，全部是分钟数（相对项目起点）。 */
export interface TaskSchedule {
  id: string;
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  slack: number;
  critical: boolean;
}

export interface EdgeSchedule {
  predecessorId: string;
  successorId: string;
  /**
   * 这条边是否落在关键路径上。
   *
   * 只「两端都关键」还不够：某个关键任务可能有多个后继，其中一条边并不是让它成为关键的那条
   * （它的最早完成时间小于后继的最早开始时间，迟一点开始也不影响后继）。所以还要这条边是紧的
   * ——前置任务的最早完成时间正好等于后继的最早开始时间。
   */
  critical: boolean;
}

export interface Schedule {
  /** 项目总工期（分钟）：所有任务最早完成时间的最大值；没有任务时为 0。 */
  projectDuration: number;
  /** 与输入 nodes 同序，方便调用方保持自己的展示顺序。 */
  tasks: TaskSchedule[];
  /** 只含两端都在 nodes 里的边，保持输入顺序（为什么丢边见 buildGraph）。 */
  edges: EdgeSchedule[];
}

/** 依赖图成环。接口的写入路径会拦住环，所以它只可能来自手工改库的脏数据。 */
export class DependencyCycleError extends Error {
  constructor() {
    super('依赖图存在环');
    this.name = 'DependencyCycleError';
  }
}

interface Graph {
  /** 去重后的任务 id，保持输入顺序。 */
  ids: string[];
  /** 工期分钟数，未估按 0。 */
  duration: Map<string, number>;
  successors: Map<string, string[]>;
  predecessors: Map<string, string[]>;
  /** 去重并丢掉悬空端点后的边，保持输入顺序。 */
  edges: ScheduleEdgeInput[];
}

/**
 * 计算每个任务的最早 / 最晚开始时间与松弛时间。
 * 依赖图成环时抛 DependencyCycleError（拓扑排序做不完）。
 */
export function computeSchedule(nodes: ScheduleNodeInput[], edges: ScheduleEdgeInput[]): Schedule {
  const graph = buildGraph(nodes, edges);
  const order = topologicalOrder(graph);
  const earliest = earliestTimes(graph, order);
  const projectDuration = Math.max(0, ...[...earliest.values()].map((time) => time.finish));
  const latest = latestTimes(graph, order, projectDuration);

  const tasks = graph.ids.map((id) => {
    const early = earliest.get(id);
    const late = latest.get(id);
    if (!early || !late) {
      // 拓扑序覆盖了全部节点，取不到只可能是 buildGraph 与这里不同步。
      throw new Error(`缺少任务的时间参数: ${id}`);
    }
    return {
      id,
      earliestStart: early.start,
      earliestFinish: early.finish,
      latestStart: late.start,
      latestFinish: late.finish,
      slack: late.start - early.start,
      critical: late.start === early.start,
    };
  });
  const criticalById = new Map(tasks.map((task) => [task.id, task.critical]));

  return {
    projectDuration,
    tasks,
    edges: graph.edges.map((edge) => ({
      ...edge,
      critical:
        criticalById.get(edge.predecessorId) === true &&
        criticalById.get(edge.successorId) === true &&
        earliest.get(edge.predecessorId)?.finish === earliest.get(edge.successorId)?.start,
    })),
  };
}

/**
 * 建邻接表。
 *
 * 防脏数据的两处：
 * - 重复的 id 只算一次（数据库主键保证不会出现，这里避免拓扑排序把节点数算多）。
 * - 两端不都在 nodes 里的边直接丢掉。同层校验保证了正常数据不会出现跨层依赖，
 *   但手工改库可以造出来；带着悬空端点算出来的时间没有意义，丢掉比返回假结果好。
 */
function buildGraph(nodes: ScheduleNodeInput[], edges: ScheduleEdgeInput[]): Graph {
  const duration = new Map<string, number>();
  const ids: string[] = [];
  for (const node of nodes) {
    if (duration.has(node.id)) continue;
    ids.push(node.id);
    duration.set(node.id, node.durationMinutes ?? 0);
  }

  const successors = new Map<string, string[]>(ids.map((id) => [id, []]));
  const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]));
  const kept: ScheduleEdgeInput[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!duration.has(edge.predecessorId) || !duration.has(edge.successorId)) continue;
    const key = `${edge.predecessorId}\n${edge.successorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    successors.get(edge.predecessorId)?.push(edge.successorId);
    predecessors.get(edge.successorId)?.push(edge.predecessorId);
    kept.push(edge);
  }

  return { ids, duration, successors, predecessors, edges: kept };
}

/** Kahn 拓扑排序。返回的序列保证每个任务都排在它的全部前置任务之后。 */
function topologicalOrder(graph: Graph): string[] {
  const indegree = new Map(graph.ids.map((id) => [id, 0]));
  for (const edge of graph.edges) {
    indegree.set(edge.successorId, (indegree.get(edge.successorId) ?? 0) + 1);
  }

  const queue = graph.ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of graph.successors.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== graph.ids.length) {
    throw new DependencyCycleError();
  }
  return order;
}

/** 正向（按拓扑序）算最早开始 / 最早完成：没有前置任务时从 0 开始。 */
function earliestTimes(graph: Graph, order: string[]): Map<string, { start: number; finish: number }> {
  const times = new Map<string, { start: number; finish: number }>();
  for (const id of order) {
    let start = 0;
    for (const predecessorId of graph.predecessors.get(id) ?? []) {
      start = Math.max(start, times.get(predecessorId)?.finish ?? 0);
    }
    times.set(id, { start, finish: start + (graph.duration.get(id) ?? 0) });
  }
  return times;
}

/**
 * 反向（按拓扑序倒着）算最晚开始 / 最晚完成。
 * 没有后继的任务用项目总工期当最晚完成时间——多终点模型下这正是「不拖长项目」的边界。
 */
function latestTimes(
  graph: Graph,
  order: string[],
  projectDuration: number,
): Map<string, { start: number; finish: number }> {
  const times = new Map<string, { start: number; finish: number }>();
  for (const id of [...order].reverse()) {
    const successors = graph.successors.get(id) ?? [];
    let finish = projectDuration;
    if (successors.length > 0) {
      finish = Math.min(...successors.map((successorId) => times.get(successorId)?.start ?? 0));
    }
    times.set(id, { start: finish - (graph.duration.get(id) ?? 0), finish });
  }
  return times;
}
