import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { ColumnRecord, LayerSchedule, ScheduleEdge, ScheduleNode } from '../api/types';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  ZOOM_FACTOR,
  edgeGeometry,
  fitCamera,
  layoutGraph,
  visibleScheduleGraph,
  zoomCamera,
} from '../domain/graph';
import type { AsyncState } from '../hooks/useAsync';
import type { Camera } from '../domain/graph';
import { cx } from '../lib/cx';
import { formatDuration, formatScheduleMinutes } from '../lib/format';
import { ErrorNote, LoadingNote } from './StatusNote';
import { ViewToolbar } from './ViewToolbar';
import type { ViewMode } from './ViewToolbar';

/**
 * 依赖图视图（第三批「关键路径可视化」，定版原型 A）。
 *
 * 形态：主区整块换成一张自左向右分层的 DAG，关键路径的节点与边用强调色；每个节点直接标出
 * 工期、最早开始、最晚开始、松弛——规范要求「每个任务标注最早开始、最晚开始、松弛时间」，
 * 放在节点上就不用点开才知道（这也是选 A 而不是「数字集中放表里」的原因）。
 *
 * 分工：坐标与相机（平移缩放）的数学都在 domain/graph.ts，这里只负责画、读 DOM 尺寸与交互。
 * 视图状态（悬停、选中、是否正在平移）在这一层，App 只告诉它「现在是不是依赖图视图」
 * 「要不要含归档」。把相机数学放在纯函数里不是为了好看：那段逻辑的边界（图比视口小、
 * 图大到撞缩放下限、视口量出来是 0）在 jsdom 里跑不到，只能靠纯函数单测钉住。
 */

const ZOOM_BUTTON =
  'grid h-[26px] min-w-[26px] place-items-center rounded-[5px] border border-line bg-surface px-1.5 text-[12px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border';

export function DependencyGraph({
  state,
  view,
  onViewChange,
  showArchived,
  columns,
  onOpenTask,
  onRetry,
}: {
  /** 这一层的依赖图。加载中与失败态也要能看见工具栏，否则用户回不去看板。 */
  state: AsyncState<LayerSchedule>;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  showArchived: boolean;
  /** 只用来把 columnId 翻成列名（详情卡与节点提示）。 */
  columns: readonly ColumnRecord[];
  onOpenTask: (taskId: string) => void;
  onRetry: () => void;
}) {
  // 过滤与布局都是纯计算，只在数据或开关变化时重算。
  const graph = useMemo(
    () => (state.status === 'ready' ? visibleScheduleGraph(state.data, showArchived) : null),
    [state, showArchived],
  );
  const layout = useMemo(
    () => (graph === null ? null : layoutGraph(graph.nodes, graph.edges)),
    [graph],
  );
  const positionById = useMemo(
    () => new Map((layout?.nodes ?? []).map((node) => [node.id, node])),
    [layout],
  );
  const columnNameById = useMemo(
    () => new Map(columns.map((column) => [column.id, column.name])),
    [columns],
  );

  const stageRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  /**
   * hover 的边。高亮的锚点取它的前置端，于是画面强调的是「这条边加上前置端的邻居」，
   * 而不是严格的「两端并集」——边只有 1.5px 粗，hover 它时用户看的是这条线本身（它自己会加粗变色）。
   */
  const [hoveredEdge, setHoveredEdge] = useState<ScheduleEdge | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * 「适应窗口」：读一次舞台尺寸交给纯函数算（边界规则见 domain/graph.ts 的 fitCamera）。
   * 这里只多一件事：layout 还没算出来时不动作。
   */
  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (stage === null || layout === null) return;
    const rect = stage.getBoundingClientRect();
    setCamera(fitCamera({ width: rect.width, height: rect.height }, layout));
  }, [layout]);

  // 换一层看板或换了「显示已归档」都会换一份 layout，这时重新适应窗口：
  // 保留上一次的平移量会让新图跑到视野外（旧图在右边时，新图可能整张都在屏幕左侧之外）。
  useLayoutEffect(() => {
    fit();
  }, [fit]);

  /** 以舞台中心为锚点缩放：中心那个任务留在原地，视觉上最不像「图跑掉了」。 */
  function zoomBy(factor: number) {
    const rect = stageRef.current?.getBoundingClientRect();
    const anchor = { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
    setCamera((current) => zoomCamera(current, factor, anchor));
  }

  /**
   * 平移。按下时记下起点与当时的相机位置，移动与松手挂在 document 上——
   * 与卡片拖拽同一套做法（hooks/useCardDrag.ts）：指针移出窗口也照样收到事件，
   * 不依赖 setPointerCapture（jsdom 里没有这个 API，测不了）。
   */
  const panRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    if (!panning) return;
    const onMove = (event: PointerEvent) => {
      const pan = panRef.current;
      if (pan === null) return;
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      // 3px 以内算手抖不算拖拽：否则一次「点空白处取消选中」会被当成平移，选中反而清不掉。
      if (!pan.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      pan.moved = true;
      setCamera((current) => ({ ...current, x: pan.originX + dx, y: pan.originY + dy }));
    };
    const onUp = () => {
      const pan = panRef.current;
      panRef.current = null;
      setPanning(false);
      // 没有移动的那一次当作「点空白处」：取消选中（详情卡随之收起）。
      if (pan !== null && !pan.moved) setSelectedId(null);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [panning]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // 节点与详情卡自己处理点击，从它们身上按下不平移。
    const target = event.target as Element;
    if (target.closest('[data-graph-node]') !== null) return;
    if (target.closest('[data-graph-detail]') !== null) return;
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: camera.x,
      originY: camera.y,
      moved: false,
    };
    setPanning(true);
  }

  /**
   * 高亮集合：hover 到某个节点（或某条边）时，它自己 + 直接前置 + 直接后继保持满色，
   * 其余元素降到 40%。返回 null 表示「没有 hover 高亮」。
   */
  const highlighted = useMemo(() => {
    if (graph === null) return null;
    // hover 的锚点必须还在当前这张图里。切换「显示已归档」（或换一层看板）时，被 hover 的节点
    // 会直接卸载，`mouseleave` 不会触发，残留的 id 会让整张图停在 40% 的变淡状态里
    // （审阅在真实浏览器里复现过）。边同样：它可能已经被过滤掉。
    const hoveredEdgeAlive =
      hoveredEdge !== null &&
      graph.edges.some(
        (edge) =>
          edge.predecessorId === hoveredEdge.predecessorId &&
          edge.successorId === hoveredEdge.successorId,
      );
    const hoveredNodeAlive =
      hoveredNodeId !== null && graph.nodes.some((node) => node.id === hoveredNodeId);
    const anchor = hoveredEdgeAlive
      ? (hoveredEdge as ScheduleEdge).predecessorId
      : hoveredNodeAlive
        ? hoveredNodeId
        : null;
    if (anchor === null) return null;

    const keep = new Set([anchor]);
    for (const edge of graph.edges) {
      if (edge.predecessorId === anchor) keep.add(edge.successorId);
      if (edge.successorId === anchor) keep.add(edge.predecessorId);
    }
    return keep;
  }, [graph, hoveredEdge, hoveredNodeId]);

  const selected = useMemo(
    () => (graph === null || selectedId === null ? null : (graph.nodes.find((node) => node.id === selectedId) ?? null)),
    [graph, selectedId],
  );

  const toolbar = (right: ReactNode) => (
    <ViewToolbar view={view} onViewChange={onViewChange}>
      {right}
    </ViewToolbar>
  );

  if (state.status === 'loading') {
    return (
      <>
        {toolbar(null)}
        <LoadingNote />
      </>
    );
  }
  if (state.status === 'failed') {
    return (
      <>
        {toolbar(null)}
        <ErrorNote message={state.message} onRetry={onRetry} />
      </>
    );
  }

  const graphToolbar = toolbar(
    <>
      {/* 图例在窄屏下藏起来：375px 上「分段控件 + 图例 + 缩放」放不下，图例是解释性的、
          缩放是操作性的，先让操作性的留下。 */}
      <div className="hidden items-center gap-3 text-[11.5px] text-ink-2 md:flex">
        <LegendItem className="border-accent-border bg-accent-weak shadow-[inset_3px_0_0_var(--color-accent)]">
          关键路径
        </LegendItem>
        <LegendItem className="border-line-strong bg-surface">非关键</LegendItem>
        <LegendItem className="border-dashed border-line-strong bg-surface">未估工期</LegendItem>
      </div>
      <button type="button" aria-label="缩小" title="缩小" className={ZOOM_BUTTON} onClick={() => zoomBy(1 / ZOOM_FACTOR)}>
        −
      </button>
      <span
        // 缩放比是点按钮后的唯一反馈，读屏用户否则什么也听不到。
        aria-live="polite"
        className="w-9 flex-none text-center text-[11.5px] tabular-nums text-ink-3"
      >
        {Math.round(camera.k * 100)}%
      </span>
      <button type="button" aria-label="放大" title="放大" className={ZOOM_BUTTON} onClick={() => zoomBy(ZOOM_FACTOR)}>
        +
      </button>
      <button type="button" className={ZOOM_BUTTON} onClick={fit}>
        适应窗口
      </button>
    </>
  );

  if (layout === null || layout.nodes.length === 0) {
    return (
      <>
        {graphToolbar}
        <p className="px-4 py-4 text-[12.5px] text-ink-3">
          这一层还没有任务，依赖图是空的。先建几个任务，再去卡片的「⋯」菜单里设置前置依赖。
        </p>
      </>
    );
  }

  return (
    <>
      {graphToolbar}
      <div
        ref={stageRef}
        data-graph-stage
        // touch-none：触摸设备上按住拖动是平移图，不是滚动页面。
        className={cx(
          'relative min-h-0 flex-1 touch-none overflow-hidden bg-canvas',
          panning ? 'cursor-grabbing' : 'cursor-grab',
        )}
        onPointerDown={handlePointerDown}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})` }}
        >
          {/*
            边画在节点下面。svg 自己 pointer-events: none，逐条边再用 pointer-events: stroke
            打开——这样空白区域不会挡住节点，而 1.5px 的细线能靠一条 14px 的透明粗线 hover 到。
          */}
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="pointer-events-none absolute left-0 top-0"
            aria-hidden="true"
          >
            {graph?.edges.map((edge) => {
              const from = positionById.get(edge.predecessorId);
              const to = positionById.get(edge.successorId);
              if (from === undefined || to === undefined) return null;
              const geometry = edgeGeometry(from, to, edge.critical);
              const dim = edgeIsDimmed(edge, hoveredEdge, highlighted, selectedId);
              const hovered = edge === hoveredEdge;
              const stroke = edge.critical || hovered ? 'var(--color-accent)' : 'var(--color-line-strong)';
              return (
                <g
                  key={`${edge.predecessorId}->${edge.successorId}`}
                  data-graph-edge={`${edge.predecessorId}->${edge.successorId}`}
                  style={{ pointerEvents: 'stroke' }}
                  className="cursor-pointer transition-opacity"
                  opacity={dim ? 0.4 : 1}
                  onMouseEnter={() => setHoveredEdge(edge)}
                  onMouseLeave={() => setHoveredEdge(null)}
                >
                  <path d={geometry.path} fill="none" stroke="transparent" strokeWidth={14} />
                  <path
                    d={geometry.path}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={edge.critical ? (hovered ? 3 : 2) : hovered ? 2 : 1.5}
                    strokeLinecap="round"
                  />
                  <path d={geometry.arrow} fill={stroke} stroke="none" />
                </g>
              );
            })}
          </svg>

          {graph?.nodes.map((node) => {
            const spot = positionById.get(node.id);
            if (spot === undefined) return null;
            return (
              <NodeCard
                key={node.id}
                node={node}
                x={spot.x}
                y={spot.y}
                selected={node.id === selectedId}
                dim={nodeIsDimmed(node.id, hoveredNodeId, highlighted, selectedId)}
                onHover={setHoveredNodeId}
                onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
                onDeselect={() => setSelectedId(null)}
              />
            );
          })}
        </div>

        {selected !== null && (
          <DetailCard
            node={selected}
            columnName={columnNameById.get(selected.columnId) ?? selected.columnId}
            // 图里藏了归档节点时，后端那份 CPM 仍然把它们算在内（见 D50 的「已知缺口」）。
            // 提示只在真的藏了东西时出现：没藏的时候这句话是噪音。
            hidesArchivedTasks={graph !== null && state.data.nodes.length > graph.nodes.length}
            onClose={() => setSelectedId(null)}
            onOpenTask={onOpenTask}
          />
        )}
      </div>
    </>
  );
}

/** 图例里的一小块色板 + 文案。色板是纯装饰，文字才是信息。 */
function LegendItem({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx('size-3 rounded-[3px] border', className)} aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * 节点卡片。整张卡是一个 button：键盘可以 Tab 到它、回车选中，读屏把它念成一个可操作项。
 *
 * 里层一律用 span（button 只允许短语内容，塞 div 是无效 HTML），高度由布局常量的内联 style 定死，
 * 不按内容量：量高度要两趟渲染，而且 jsdom 里量出来是 0，布局就没法单测了。
 */
function NodeCard({
  node,
  x,
  y,
  selected,
  dim,
  onHover,
  onSelect,
  onDeselect,
}: {
  node: ScheduleNode;
  x: number;
  y: number;
  selected: boolean;
  dim: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  /** 收起详情（点 ×、点空白处、按 Escape 都是它）。 */
  onDeselect: () => void;
}) {
  const archived = node.archivedAt !== null;
  return (
    <button
      type="button"
      data-graph-node={node.id}
      aria-pressed={selected}
      style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cx(
        'absolute overflow-hidden rounded-[5px] border px-2 pb-2 pt-[7px] text-left transition-opacity',
        'shadow-[0_1px_2px_rgba(20,24,30,.05)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border',
        // 底色与边框按「是否关键」二选一给，不做条件类叠加：cx 只拼字符串、不去重，
        // 同一属性出现两次时谁生效由生成样式表的源序决定（见 docs/decisions.md D39）。
        node.critical ? 'border-accent-border bg-accent-weak' : 'border-line bg-surface',
        node.durationMinutes === null && 'border-dashed',
        dim && 'opacity-40',
        selected && 'ring-2 ring-accent',
      )}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.id)}
      onBlur={() => onHover(null)}
      onClick={() => onSelect(node.id)}
      onKeyDown={(event) => {
        // Escape 取消选中：与点空白处同一个动作（详情卡跟着收起）。
        // 直接调 onDeselect 而不是 onSelect(node.id)——后者是「切换」，焦点停在一个没选中的
        // 节点上按 Escape 反而会把它选中。
        if (event.key === 'Escape') onDeselect();
      }}
    >
      {node.critical && (
        <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" aria-hidden="true" />
      )}
      {/* 标题固定占两行的高度：卡片定高，标题一行还是两行都不该让下面的数字错位。 */}
      <span className="flex h-[34px] items-start gap-1.5">
        <span
          className={cx(
            'line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-[1.35]',
            node.critical && 'font-semibold',
            archived && 'italic text-ink-3',
          )}
        >
          {node.title}
        </span>
        {node.durationMinutes === null && (
          <span className="flex-none rounded-[3px] border border-dashed border-line-strong px-1 text-[10.5px] leading-[15px] text-ink-2">
            未估
          </span>
        )}
        {archived && (
          <span className="flex-none rounded-[3px] border border-dashed border-line-strong px-1 text-[10.5px] italic leading-[15px] text-ink-3">
            已归档
          </span>
        )}
      </span>
      <span className="mt-[3px] block text-[11.5px] leading-[17px] text-ink-2">
        {formatDuration(node.durationMinutes)}
      </span>
      <span
        className={cx(
          'mt-1 grid grid-cols-[1fr_auto] gap-x-1.5 border-t pt-1',
          node.critical ? 'border-accent-border' : 'border-line',
        )}
      >
        <NumRow label="最早开始" value={formatScheduleMinutes(node.earliestStart)} />
        <NumRow label="最晚开始" value={formatScheduleMinutes(node.latestStart)} />
        <NumRow
          label="松弛"
          value={formatScheduleMinutes(node.slack)}
          emphasize={node.slack === 0}
        />
      </span>
    </button>
  );
}

/** 节点里的一行数字：标签在左、等宽数字靠右。 */
function NumRow({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <>
      <span className="text-[10.5px] leading-[15px] text-ink-3">{label}</span>
      <span
        className={cx(
          'text-right font-mono text-[11.5px] leading-[15px] tabular-nums',
          emphasize === true ? 'text-accent' : 'text-ink-2',
        )}
      >
        {value}
      </span>
    </>
  );
}

/**
 * 选中节点的详情卡。节点上已经有工期、最早开始、最晚开始与松弛，这里补上最早/最晚**结束**、
 * 列名与「进入看板」——点节点只是选中（图不该一点就跳走），要进那一层看板得按这个按钮。
 */
function DetailCard({
  node,
  columnName,
  hidesArchivedTasks,
  onClose,
  onOpenTask,
}: {
  node: ScheduleNode;
  columnName: string;
  /** 图里是否藏了归档任务（关着「显示已归档」且这一层确实有归档任务）。 */
  hidesArchivedTasks: boolean;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <aside
      data-graph-detail
      aria-label={`${node.title} 的排期`}
      // max-w 与 w 一起用：宽屏下是固定 268px 的卡片，窄屏（375px 视口 + 任务树展开时主区只有
      // 123px）下跟着缩到「主区宽 − 左右各 14px」。只在 w 上做响应式会把内容挤扁，只给 max-w
      // 不改 w 又不会缩——两者都要（审阅实测过：不缩时卡片左溢 159px，「进入看板」四个字整个看不见）。
      className="absolute bottom-3.5 right-3.5 w-[268px] max-w-[calc(100%-28px)] rounded-[6px] border border-line bg-surface p-2.5 shadow-menu"
    >
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-[1.35]">{node.title}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭详情"
          className="-mr-0.5 -mt-0.5 grid size-[18px] flex-none place-items-center rounded-[4px] text-[14px] leading-none text-ink-3 hover:bg-track hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border"
        >
          ×
        </button>
      </div>
      <p className="mt-0.5 text-[11.5px] text-ink-2">
        {columnName} · {formatDuration(node.durationMinutes)}
        <span
          className={cx(
            'ml-1.5 inline-block rounded-[3px] border px-[5px] text-[10.5px]',
            node.critical
              ? 'border-accent-border bg-accent-weak text-accent'
              : 'border-line bg-surface-2 text-ink-2',
          )}
        >
          {node.critical ? '关键路径' : '非关键'}
        </span>
        {node.archivedAt !== null && (
          <span className="ml-1.5 inline-block rounded-[3px] border border-dashed border-line-strong px-[5px] text-[10.5px] italic text-ink-3">
            已归档
          </span>
        )}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[11.5px]">
        <DetailRow label="最早开始" value={formatScheduleMinutes(node.earliestStart)} />
        <DetailRow label="最早结束" value={formatScheduleMinutes(node.earliestFinish)} />
        <DetailRow label="最晚开始" value={formatScheduleMinutes(node.latestStart)} />
        <DetailRow label="最晚结束" value={formatScheduleMinutes(node.latestFinish)} />
        <DetailRow label="松弛时间" value={formatScheduleMinutes(node.slack)} />
      </dl>
      {hidesArchivedTasks && (
        // 一句话解释「图里明明没有这个前置，为什么它是关键任务」：时间参数是后端按
        // 含归档任务的完整图算出来的，前端只是把归档节点藏了起来。
        <p className="mt-2 border-t border-line pt-1.5 text-[10.5px] leading-[15px] text-ink-3">
          时间参数按包含已归档任务计算，藏起来的前置仍会影响这些数字。
        </p>
      )}
      <button
        type="button"
        onClick={() => onOpenTask(node.id)}
        className="mt-2.5 h-[26px] w-full rounded-[5px] bg-accent px-2.5 text-[12px] text-on-fill hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border"
      >
        进入看板
      </button>
    </aside>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="m-0 text-right font-mono tabular-nums">{value}</dd>
    </>
  );
}

/** 节点是否该变淡。hover 优先于选中：hover 时只留「它和它的直接邻居」。 */
function nodeIsDimmed(
  id: string,
  hoveredNodeId: string | null,
  highlighted: Set<string> | null,
  selectedId: string | null,
): boolean {
  if (highlighted !== null) return !highlighted.has(id);
  if (selectedId !== null) return id !== selectedId;
  return false;
}

/**
 * 边是否该变淡。hover 时要求两端都在高亮集合里；否则只要有一端是选中项就保持满色
 * （否则选中一个任务后，连向它的边会一起变淡，看不出它的上下游）。
 */
function edgeIsDimmed(
  edge: ScheduleEdge,
  hoveredEdge: ScheduleEdge | null,
  highlighted: Set<string> | null,
  selectedId: string | null,
): boolean {
  if (highlighted !== null) {
    // 直接 hover 的那一条永远是满色（它的两端本来就在集合里，这里只是不依赖这一点）。
    if (edge === hoveredEdge) return false;
    return !(highlighted.has(edge.predecessorId) && highlighted.has(edge.successorId));
  }
  if (selectedId !== null) return edge.predecessorId !== selectedId && edge.successorId !== selectedId;
  return false;
}
