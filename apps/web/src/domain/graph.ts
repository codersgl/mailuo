import type { LayerSchedule, ScheduleEdge, ScheduleNode } from '../api/types';

/**
 * 依赖图视图的纯计算：可见性过滤、分层布局、边的曲线路径。
 *
 * 与 domain/board.ts、domain/search.ts、domain/layerDeps.ts 同一分工：能脱离 DOM 与网络单独测的
 * 计算都放在这里。组件只负责把算好的坐标画出来。
 *
 * 布局不引入图布局库（dagre / elkjs）：这一层的图来自后端 CPM，节点数就是这一层的任务数（个人规模），
 * 而「按依赖深度分层 + 层内按看板顺序」用一次拓扑排序就能算准。多一个依赖换来的主要是交叉最小化，
 * 那是任务上千时才值回票价的东西（见 docs/decisions.md D50）。
 */

/**
 * 节点卡片的宽高（像素）。布局与组件共用这两个常量：组件把它们写进内联 style，
 * 所以「算出来的位置」与「画出来的盒子」不会因为 CSS 改动而错位。
 *
 * 高度定死而不是按内容量：量真实高度要把布局变成两趟渲染（先渲染、量、再摆），
 * 而且 jsdom 里量出来是 0，布局就没法单测了。卡片里的标题固定占两行、其余各行高度固定，
 * 所以内容高度是一个定值——**改卡片内部间距（DependencyGraph 的 NodeCard 与 NumRow）
 * 就必须同步改这里**，否则内容会比盒子高一点点、被 overflow-hidden 裁掉。
 * 125 是按 NodeCard 的实际内容算的：pt 7 + 标题 34 + mt 3 + 工期 17 + mt 4 + 分隔线 1
 * + pt 4 + 三行数字 45 + pb 8 = 123，再加卡片自身的上下边框 2px（border-box）。
 */
export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 125;

/** 层间距。要容下 168px 宽的卡片、中间留出画边的空间。 */
export const LAYER_GAP = 230;
/** 层内相邻两行卡片之间的空隙。 */
export const ROW_GAP = 12;
/**
 * 画布四周留白。导出给测试用：断言「画布尺寸 = 最右/最下节点 + 这一圈留白」，
 * 否则把留白整条删掉也不会红（审阅的变异检验抓到过）。
 */
export const CANVAS_PADDING = 40;

/** 箭头长度。曲线终点要往回收这么多，箭头才落在卡片边缘之外而不是压住边框。 */
const ARROW_LENGTH = 7;

export interface PlacedNode {
  id: string;
  /** 层号：0 表示这一层里没有前置依赖的任务。 */
  layer: number;
  x: number;
  y: number;
}

export interface GraphLayout {
  /** 顺序与传入的 nodes 一致，方便调用方按下标取坐标。 */
  nodes: PlacedNode[];
  /** 画布尺寸（像素），用来设置 SVG 的 viewBox 与「适应窗口」。 */
  width: number;
  height: number;
}

/**
 * 把这一层的依赖图算成坐标。
 *
 * - 层号 = 从任一起点算到该任务的**最长**路径边数（`layer(v) = max(layer(p) + 1)`）。
 *   用最长路径而不是最短路径：只要有一条前置链没走完，这个任务就不能开始，
 *   所以它必须排在那条链的右边，否则图上的左右顺序会与「谁先谁后」矛盾。
 * - 层内顺序就是传入 nodes 的顺序。调用方传的是 cpm 响应里的节点顺序，
 *   后端已按「列 orders + 列内 orders」排好，所以层内天然是看板上的列序与列内序，
 *   这里不需要知道列的存在。
 * - 每层在自己的高度内垂直居中，图看起来是横向流动的，而不是每层都顶着上边。
 *
 * 脏数据兜底：成环时环上的节点（以及它们的下游）拿不到层号，一律当第 0 层。
 * 后端写入前做环检测、cpm 读接口遇环直接 500，所以正常路径下走不到这里；
 * 不特判是因为「算不出来就摆在第 0 层」比抛异常或死循环更适合一张只读的图。
 */
export function layoutGraph(
  nodes: readonly { id: string }[],
  edges: readonly { predecessorId: string; successorId: string }[],
): GraphLayout {
  const known = new Set(nodes.map((node) => node.id));
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const node of nodes) {
    successors.set(node.id, []);
    predecessors.set(node.id, []);
  }
  for (const edge of edges) {
    // 两端有一端不在这张图里的边直接丢掉。调用方（visibleScheduleGraph）已经过滤过，
    // 这里是兜底：一条指向不存在节点的边会让下面取 successors 时读到 undefined。
    if (!known.has(edge.predecessorId) || !known.has(edge.successorId)) continue;
    (successors.get(edge.predecessorId) as string[]).push(edge.successorId);
    (predecessors.get(edge.successorId) as string[]).push(edge.predecessorId);
  }

  const layerOf = new Map<string, number>();
  const indegree = new Map<string, number>();
  for (const node of nodes) indegree.set(node.id, (predecessors.get(node.id) as string[]).length);

  // Kahn 拓扑序：入度 0 的先出队，每出一条边就把它后继的层号抬到「自己层号 + 1」。
  // 用游标而不是 queue.shift()：后者是 O(n²)（与后端拓扑排序同一个考虑）。
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor] as string;
    cursor += 1;
    const layer = layerOf.get(id) ?? 0;
    for (const next of successors.get(id) as string[]) {
      const raised = layer + 1;
      if (raised > (layerOf.get(next) ?? 0)) layerOf.set(next, raised);
      const left = (indegree.get(next) as number) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  // 层号 → 该层的节点（按传入顺序追加）。用 Map 而不是数组下标：数组下标在
  // noUncheckedIndexedAccess 下处处是 undefined，Map 上「这一层还不存在」是显式的。
  const byLayer = new Map<number, { id: string }[]>();
  let maxLayer = 0;
  for (const node of nodes) {
    const layer = layerOf.get(node.id) ?? 0;
    const column = byLayer.get(layer);
    if (column === undefined) byLayer.set(layer, [node]);
    else column.push(node);
    if (layer > maxLayer) maxLayer = layer;
  }

  // 最高的一层决定画布高度；每层在自己的高度内居中。
  let tallest = 0;
  for (const column of byLayer.values()) {
    const stack = column.length * NODE_HEIGHT + (column.length - 1) * ROW_GAP;
    if (stack > tallest) tallest = stack;
  }

  const placed: PlacedNode[] = [];
  const positionById = new Map<string, PlacedNode>();
  let width = 0;
  let height = 0;
  for (let layer = 0; layer <= maxLayer; layer += 1) {
    const column = byLayer.get(layer);
    // 层号连续性由拓扑分层保证：0..maxLayer 每一层至少有一个节点，所以这里取不到只可能是
    // 内部 bug（见审计报告 D10）。保留这个分支是因为布局函数不该抛异常——真出现空洞时
    // 跳过一层，比整张图画不出来要好。
    if (column === undefined) continue;
    const stack = column.length * NODE_HEIGHT + (column.length - 1) * ROW_GAP;
    const top = CANVAS_PADDING + (tallest - stack) / 2;
    column.forEach((node, row) => {
      const spot: PlacedNode = {
        id: node.id,
        layer,
        x: CANVAS_PADDING + layer * LAYER_GAP,
        y: top + row * (NODE_HEIGHT + ROW_GAP),
      };
      positionById.set(node.id, spot);
      placed.push(spot);
      width = Math.max(width, spot.x + NODE_WIDTH);
      height = Math.max(height, spot.y + NODE_HEIGHT);
    });
  }

  if (placed.length === 0) return { nodes: [], width: 0, height: 0 };
  // 记录顺序跟传入的 nodes 一致，调用方按下标取坐标最省事。
  const ordered = nodes.map((node) => positionById.get(node.id)).filter(isPlaced);
  return { nodes: ordered, width: width + CANVAS_PADDING, height: height + CANVAS_PADDING };
}

function isPlaced(value: PlacedNode | undefined): value is PlacedNode {
  return value !== undefined;
}

/** 一条边的画法：曲线本身 + 目标端的小三角。 */
export interface EdgeGeometry {
  /** 三次贝塞尔曲线。 */
  path: string;
  /** 箭头（实心三角形）的路径。 */
  arrow: string;
  /** 曲线终点，调试与测试用。 */
  end: { x: number; y: number };
}

/**
 * 从 `from` 的右边缘连到 `to` 的左边缘。
 *
 * 出发点纵坐标的偏移是照定版原型 A 做的：关键边从卡片垂直中心出发，非关键边往下 18px 出发。
 * 于是「一个关键任务同时有进出关键边与非关键边」时，两条线在起点附近不会叠成一条。
 * 代价是同一个节点发出的多条非关键边仍然会重叠——个人规模下图不密，先不引入绕行路由。
 *
 * 端点不在右边时（`endX <= startX`）会画出一条折返、穿过源卡片的曲线。这种数据只可能来自
 * 手工改库：分层保证 `层(后继) > 层(前置)`，而后端在写入与读取两处都拒绝环（见 D48）。
 * 不为此写绕行路由——那是「交叉最小化」那一类被刻意跳过的复杂度；宁可把脏数据画得难看，
 * 也不要悄悄丢掉一条边让用户以为依赖不存在。
 */
export function edgeGeometry(
  from: { x: number; y: number },
  to: { x: number; y: number },
  critical: boolean,
): EdgeGeometry {
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2 + (critical ? 0 : 18);
  const endX = to.x - ARROW_LENGTH - 1;
  const endY = to.y + NODE_HEIGHT / 2;
  // 控制点至少外推 38px：两端贴得很近时（同层或跨层很短）曲线才不会被压成一条直线段。
  const bend = Math.max(38, (endX - startX) * 0.5);

  return {
    path: `M${startX} ${startY} C${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
    arrow: `M${endX} ${endY} L${endX - ARROW_LENGTH} ${endY - 4.5} L${endX - ARROW_LENGTH} ${endY + 4.5} Z`,
    end: { x: endX, y: endY },
  };
}

/**
 * 按「显示已归档」开关过滤一张层的依赖图。
 *
 * 依赖图是固定带归档取的（见 hooks/useLayerSchedule.ts 的 D49 理由：抽屉要靠它认出已归档的前置），
 * 所以「图视图要不要显示归档任务」只能在前端过滤：关着开关时把归档节点与连着它的边一起去掉，
 * 口径与看板列、任务树一致。
 */
export function visibleScheduleGraph(
  schedule: LayerSchedule,
  includeArchived: boolean,
): { nodes: ScheduleNode[]; edges: ScheduleEdge[] } {
  if (includeArchived) return { nodes: schedule.nodes, edges: schedule.edges };
  const nodes = schedule.nodes.filter((node) => node.archivedAt === null);
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: schedule.edges.filter(
      (edge) => ids.has(edge.predecessorId) && ids.has(edge.successorId),
    ),
  };
}

/**
 * 视口参数（相机）：`k` 是缩放比，`x`/`y` 是画布左上角在视口里的位移。
 * 与 `layoutGraph` 一样是纯数据，平移缩放的计算因此可以脱离 DOM 单测。
 */
export interface Camera {
  x: number;
  y: number;
  /** 缩放比，1 表示 100%。 */
  k: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;
/** 每次点 +/- 的缩放倍率。 */
export const ZOOM_FACTOR = 1.2;
/** 「适应窗口」时四周留的空白。 */
export const FIT_PADDING = 20;

/**
 * 「适应窗口」：把整张图缩到能全部看见，并居中。
 *
 * 三条边界写清楚：
 *
 * - **不放大**（`k` 上限 1）：1:1 时卡片上的 11.5px 数字最清楚，放大只是把同一张卡片画得更大。
 * - **下限 MIN_ZOOM**：图大到连 30% 都装不下时也只能到 30%——「适应窗口」在那种规模下确实
 *   装不下整张图（审阅用 30 个节点单层实测过：画布 4148px 高，558px 的舞台只显示约 1/3）。
 *   不为了「名副其实」继续缩小，是因为再小字就看不清了，而且工具栏里还有缩放百分比可以看。
 * - 视口或图尺寸为 0（jsdom 不做布局、空图）时返回初始相机，不按 0 去算比例（会得到 0 或负数）。
 */
export function fitCamera(
  viewport: { width: number; height: number },
  layout: { width: number; height: number },
): Camera {
  if (viewport.width === 0 || viewport.height === 0 || layout.width === 0 || layout.height === 0) {
    return { x: 0, y: 0, k: 1 };
  }
  const k = clamp(
    Math.min(
      (viewport.width - FIT_PADDING * 2) / layout.width,
      (viewport.height - FIT_PADDING * 2) / layout.height,
    ),
    MIN_ZOOM,
    1,
  );
  return {
    k,
    // 居中；图比视口小的时候内边距至少留 FIT_PADDING，不然会贴在左上角。
    x: Math.max(FIT_PADDING, (viewport.width - layout.width * k) / 2),
    y: Math.max(FIT_PADDING, (viewport.height - layout.height * k) / 2),
  };
}

/**
 * 以 `anchor`（视口坐标）为不动点缩放 `factor` 倍。
 * 缩放比夹在 [MIN_ZOOM, MAX_ZOOM] 之间；到边界时比值取真实的 `k / 旧 k`，
 * 因此「不动点」这个性质在边界上依然成立（连续点十次 + 不会把图推走）。
 */
export function zoomCamera(camera: Camera, factor: number, anchor: { x: number; y: number }): Camera {
  const k = clamp(camera.k * factor, MIN_ZOOM, MAX_ZOOM);
  const ratio = k / camera.k;
  return {
    k,
    x: anchor.x - (anchor.x - camera.x) * ratio,
    y: anchor.y - (anchor.y - camera.y) * ratio,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
