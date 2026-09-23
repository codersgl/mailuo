import { describe, expect, it } from 'vitest';
import {
  CANVAS_PADDING,
  LAYER_GAP,
  FIT_PADDING,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_HEIGHT,
  NODE_WIDTH,
  ROW_GAP,
  ZOOM_FACTOR,
  edgeGeometry,
  fitCamera,
  layoutGraph,
  visibleScheduleGraph,
  zoomCamera,
} from '../src/domain/graph';
import type { LayerSchedule, ScheduleEdge, ScheduleNode } from '../src/api/types';

/**
 * 依赖图的分层布局、边的画法与归档过滤。
 *
 * 数据用定版原型 A 那一份（7 个任务、6 条依赖、关键路径 t1 → t3 → t6），
 * 断言尽量写成「与常量/输入的关系」而不是硬编码像素：换 NODE_WIDTH 不该让用例红，
 * 但层号算错、层内顺序变成随机、边的起点跑到卡片外，一定要红。
 */

function node(overrides: Partial<ScheduleNode> & Pick<ScheduleNode, 'id'>): ScheduleNode {
  return {
    title: overrides.id,
    columnId: 'todo',
    durationMinutes: 60,
    archivedAt: null,
    earliestStart: 0,
    earliestFinish: 60,
    latestStart: 0,
    latestFinish: 60,
    slack: 0,
    critical: false,
    ...overrides,
  };
}

/** cpm 响应里的节点顺序：列 orders + 列内 orders（todo → doing → done）。 */
const NODES: ScheduleNode[] = [
  node({ id: 't4', columnId: 'todo', durationMinutes: null, slack: 1380 }),
  node({ id: 't7', columnId: 'todo', slack: 900 }),
  node({ id: 't6', columnId: 'todo', earliestStart: 1440, latestStart: 1440, critical: true }),
  node({ id: 't1', columnId: 'doing', durationMinutes: 480, critical: true }),
  node({ id: 't3', columnId: 'doing', durationMinutes: 960, earliestStart: 480, latestStart: 480, critical: true }),
  node({ id: 't2', columnId: 'done', durationMinutes: 240, slack: 240 }),
  node({ id: 't5', columnId: 'done', durationMinutes: 480, slack: 900 }),
];

const EDGES: ScheduleEdge[] = [
  { predecessorId: 't1', successorId: 't3', critical: true },
  { predecessorId: 't2', successorId: 't3', critical: false },
  { predecessorId: 't4', successorId: 't7', critical: false },
  { predecessorId: 't5', successorId: 't7', critical: false },
  { predecessorId: 't7', successorId: 't6', critical: false },
  { predecessorId: 't3', successorId: 't6', critical: true },
];

function layerOf(nodes: ReturnType<typeof layoutGraph>['nodes'], id: string): number {
  const found = nodes.find((item) => item.id === id);
  if (found === undefined) throw new Error(`布局里没有 ${id}`);
  return found.layer;
}

describe('依赖图布局', () => {
  it('层号是最长路径边数：0 / 1 / 2 三层', () => {
    const layout = layoutGraph(NODES, EDGES);
    for (const id of ['t1', 't2', 't4', 't5']) expect(layerOf(layout.nodes, id)).toBe(0);
    for (const id of ['t3', 't7']) expect(layerOf(layout.nodes, id)).toBe(1);
    expect(layerOf(layout.nodes, 't6')).toBe(2);
  });

  it('取最长路径而不是最短路径', () => {
    // x 直接依赖 a（第 1 层）与 b→c（第 2 层）：x 必须落在第 3 层。
    // 用最短路径会算出第 2 层，图上就会出现「x 和它的前置 c 同一列」。
    const nodes = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' }), node({ id: 'x' })];
    const edges: ScheduleEdge[] = [
      { predecessorId: 'a', successorId: 'x', critical: false },
      { predecessorId: 'a', successorId: 'b', critical: false },
      { predecessorId: 'b', successorId: 'c', critical: false },
      { predecessorId: 'c', successorId: 'x', critical: false },
    ];
    const layout = layoutGraph(nodes, edges);
    expect(layerOf(layout.nodes, 'a')).toBe(0);
    expect(layerOf(layout.nodes, 'b')).toBe(1);
    expect(layerOf(layout.nodes, 'c')).toBe(2);
    expect(layerOf(layout.nodes, 'x')).toBe(3);
  });

  it('层内顺序保持传入顺序（也就是看板上的列序与列内序）', () => {
    const layout = layoutGraph(NODES, EDGES);
    const layer0 = layout.nodes.filter((item) => item.layer === 0).map((item) => item.id);
    const layer1 = layout.nodes.filter((item) => item.layer === 1).map((item) => item.id);
    expect(layer0).toEqual(['t4', 't1', 't2', 't5']);
    expect(layer1).toEqual(['t7', 't3']);
  });

  it('层内的上下顺序也跟着传入顺序（从上到下就是列序与列内序）', () => {
    // 这一条与上一条是两件事：上一条查的是返回数组的顺序（它按传入顺序重建），
    // 这一条查的是**真实行号**。审阅的变异检验指出过：把行号改成倒序，只查数组顺序是看不出来的。
    // 只能按层比：每层在最高层里垂直居中，所以第 1 层的第 1 张卡可能比第 0 层的第 3 张卡更靠上。
    const layout = layoutGraph(NODES, EDGES);
    const ordered = (layer: number) =>
      layout.nodes
        .filter((item) => item.layer === layer)
        .sort((left, right) => left.y - right.y)
        .map((item) => item.id);
    expect(ordered(0)).toEqual(['t4', 't1', 't2', 't5']);
    expect(ordered(1)).toEqual(['t7', 't3']);
  });

  it('每层在最高那一层的高度里垂直居中，矮的层不贴顶', () => {
    const layout = layoutGraph(NODES, EDGES);
    // 第 0 层最高（4 张卡），它就是画布的内容高度基准；矮的层按「差了几行」的一半下移。
    const top = (id: string) => layout.nodes.find((item) => item.id === id)?.y as number;
    const row = NODE_HEIGHT + ROW_GAP;
    expect(top('t4')).toBe(CANVAS_PADDING);
    expect(top('t7') - top('t4')).toBe(((4 - 2) * row) / 2);
    expect(top('t6') - top('t4')).toBe(((4 - 1) * row) / 2);
  });

  it('输出顺序与传入的节点顺序一致，画布尺寸刚好包住所有节点', () => {
    const layout = layoutGraph(NODES, EDGES);
    expect(layout.nodes.map((item) => item.id)).toEqual(NODES.map((item) => item.id));

    for (const item of layout.nodes) {
      expect(item.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(item.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
    // 画布 = 最右/最下节点 + 四周留白。写死这个关系（而不是「留白小于一个卡片宽」）是因为
    // 后者太松：把留白整条删掉也能过（审阅的变异检验抓到过）。
    const right = Math.max(...layout.nodes.map((item) => item.x + NODE_WIDTH));
    const bottom = Math.max(...layout.nodes.map((item) => item.y + NODE_HEIGHT));
    expect(layout.width).toBe(right + CANVAS_PADDING);
    expect(layout.height).toBe(bottom + CANVAS_PADDING);
    const x = (id: string) => layout.nodes.find((item) => item.id === id)?.x as number;
    expect(x('t4')).toBe(CANVAS_PADDING);
    // 相邻两层正好差一个层间距：层是等距的，不按每层的内容宽窄变。
    expect(x('t7') - x('t4')).toBe(LAYER_GAP);
    expect(x('t6') - x('t7')).toBe(LAYER_GAP);
  });

  it('同一层里的节点横向对齐、纵向不重叠', () => {
    const layout = layoutGraph(NODES, EDGES);
    const layer0 = layout.nodes.filter((item) => item.layer === 0);
    expect(new Set(layer0.map((item) => item.x)).size).toBe(1);
    const ys = layer0.map((item) => item.y).sort((left, right) => left - right);
    for (let index = 1; index < ys.length; index += 1) {
      // 相邻两张卡片之间至少隔开一个卡片高度，不然会叠在一起。
      expect((ys[index] as number) - (ys[index - 1] as number)).toBeGreaterThanOrEqual(NODE_HEIGHT);
    }
  });

  it('成环的脏数据不会死循环，环上的节点一律摆在第 0 层', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];
    const edges: ScheduleEdge[] = [
      { predecessorId: 'a', successorId: 'b', critical: false },
      { predecessorId: 'b', successorId: 'a', critical: false },
    ];
    const layout = layoutGraph(nodes, edges);
    expect(layout.nodes.map((item) => item.layer)).toEqual([0, 0]);
  });

  it('空层返回空布局而不是 NaN 或负数', () => {
    expect(layoutGraph([], [])).toEqual({ nodes: [], width: 0, height: 0 });
  });

  it('忽略两端不在这张图里的边', () => {
    const nodes = [node({ id: 'a' })];
    const edges: ScheduleEdge[] = [{ predecessorId: 'ghost', successorId: 'a', critical: false }];
    const layout = layoutGraph(nodes, edges);
    expect(layout.nodes).toHaveLength(1);
    expect(layerOf(layout.nodes, 'a')).toBe(0);
  });
});

describe('边的画法', () => {
  const from = { x: 100, y: 200 };
  const to = { x: 500, y: 260 };

  it('从起点的右边缘连到目标左边缘，箭头落在卡片之外', () => {
    const geometry = edgeGeometry(from, to, true);
    expect(geometry.path.startsWith(`M${from.x + NODE_WIDTH} ${from.y + NODE_HEIGHT / 2}`)).toBe(true);
    // 终点要往回收一个箭头长度，否则三角形会压在目标卡片的边框上。
    expect(geometry.end.x).toBeLessThan(to.x);
    expect(geometry.end.x).toBeGreaterThan(to.x - 12);
    expect(geometry.end.y).toBe(to.y + NODE_HEIGHT / 2);
    expect(geometry.arrow).toContain(`M${geometry.end.x} ${geometry.end.y}`);
  });

  it('非关键边从垂直中心往下偏 18px 出发，关键边不偏', () => {
    const critical = edgeGeometry(from, to, true);
    const normal = edgeGeometry(from, to, false);
    expect(critical.path).toContain(`M${from.x + NODE_WIDTH} ${from.y + NODE_HEIGHT / 2}`);
    expect(normal.path).toContain(`M${from.x + NODE_WIDTH} ${from.y + NODE_HEIGHT / 2 + 18}`);
    // 终点一样：偏移只影响出发那一端。
    expect(normal.end).toEqual(critical.end);
  });

  it('两端挨得很近时控制点仍外推 38px，曲线不被压成直线段', () => {
    // 目标紧挨着源卡片右边缘：按差值的 1/2 算会得到接近 0 的外推，曲线就成了直线。
    const geometry = edgeGeometry({ x: 0, y: 0 }, { x: NODE_WIDTH + 1, y: 0 }, true);
    const startX = NODE_WIDTH;
    expect(geometry.path).toContain(`C${startX + 38} `);
  });
});

describe('相机（适应窗口与缩放）', () => {
  it('图比视口大：缩小到装得下，并居中', () => {
    const camera = fitCamera({ width: 900, height: 558 }, { width: 708, height: 612 });
    // 受高度限制：558 - 40 = 518，518 / 612 ≈ 0.8464。
    expect(camera.k).toBeCloseTo(518 / 612, 4);
    expect(camera.x).toBeCloseTo((900 - 708 * camera.k) / 2, 4);
    expect(camera.y).toBeCloseTo(20, 4);
  });

  it('图比视口小：不放大（k 恒为 1），并居中', () => {
    const camera = fitCamera({ width: 900, height: 600 }, { width: 400, height: 300 });
    expect(camera.k).toBe(1);
    expect(camera.x).toBe(250);
    expect(camera.y).toBe(150);
  });

  it('图非常大时缩放下限生效，且不会把图推到左上角之外', () => {
    // 30 个节点单层这种规模：真实画布四千多像素，30% 也装不下整张图。
    // 宽度也超过视口，所以居中的结果是负数，必须被 FIT_PADDING 兜住（否则图会跑到画布外面）。
    const camera = fitCamera({ width: 900, height: 558 }, { width: 5000, height: 4148 });
    expect(camera.k).toBe(MIN_ZOOM);
    expect(camera.x).toBe(20);
    expect(camera.y).toBe(20);
  });

  it('视口或图尺寸为 0 时回初始相机，不按 0 去算比例', () => {
    expect(fitCamera({ width: 0, height: 600 }, { width: 708, height: 612 })).toEqual({ x: 0, y: 0, k: 1 });
    expect(fitCamera({ width: 900, height: 600 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('缩放以锚点为不动点：锚点下那个画布坐标在缩放前后不变', () => {
    const camera = { x: 40, y: 20, k: 1 };
    const anchor = { x: 300, y: 200 };
    const canvasX = (anchor.x - camera.x) / camera.k;
    const next = zoomCamera(camera, ZOOM_FACTOR, anchor);
    expect(next.k).toBeCloseTo(ZOOM_FACTOR, 6);
    expect((anchor.x - next.x) / next.k).toBeCloseTo(canvasX, 6);
    expect((anchor.y - next.y) / next.k).toBeCloseTo((anchor.y - camera.y) / camera.k, 6);
  });

  it('缩放比夹在上下限之间，且到限后继续点不会把图推走', () => {
    const anchor = { x: 300, y: 200 };
    let camera = { x: 0, y: 0, k: 1 };
    for (let times = 0; times < 10; times += 1) camera = zoomCamera(camera, ZOOM_FACTOR, anchor);
    expect(camera.k).toBe(MAX_ZOOM);
    const atMax = camera;
    camera = zoomCamera(camera, ZOOM_FACTOR, anchor);
    expect(camera).toEqual(atMax);

    for (let times = 0; times < 20; times += 1) camera = zoomCamera(camera, 1 / ZOOM_FACTOR, anchor);
    expect(camera.k).toBe(MIN_ZOOM);
  });
});

describe('归档过滤', () => {
  const withArchived: LayerSchedule = {
    parentId: null,
    projectDuration: 120,
    nodes: [node({ id: 'a' }), node({ id: 'b', archivedAt: '2026-09-23T00:00:00.000Z' })],
    edges: [
      { predecessorId: 'a', successorId: 'b', critical: false },
      { predecessorId: 'b', successorId: 'a', critical: false },
    ],
  };

  it('关着「显示已归档」时去掉归档节点与连着它的边', () => {
    const visible = visibleScheduleGraph(withArchived, false);
    expect(visible.nodes.map((item) => item.id)).toEqual(['a']);
    expect(visible.edges).toEqual([]);
  });

  it('打开时原样返回', () => {
    const visible = visibleScheduleGraph(withArchived, true);
    expect(visible.nodes).toHaveLength(2);
    expect(visible.edges).toHaveLength(2);
  });
});
