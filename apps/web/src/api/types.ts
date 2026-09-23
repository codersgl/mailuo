/**
 * 后端看板接口的返回结构（见 docs/spec.md 的 API 契约）。
 * 字段名与后端一致，全 camelCase；数据库的 snake_case 只在后端内部出现。
 */

/**
 * 任务的完整字段。写接口响应里的 `task` 就是这个形状（不含子任务计数），
 * 所以「面板保存后把新值并回本地快照」不需要再拉一次任务。
 */
export interface TaskRecord {
  id: string;
  parentId: string | null;
  columnId: string;
  title: string;
  description: string;
  /** 工期，单位分钟；null 表示未估工期，0 表示瞬时任务。 */
  durationMinutes: number | null;
  /** 已结算的累计用时（分钟），只在「进行中」列里增长（见 docs/spec.md 的「工期提醒」）。 */
  spentMinutes: number;
  /** 正在计时的这一段的开始时刻；非空表示任务此刻在跑。非空 ⟺ 进行中且未归档。 */
  runningSince: string | null;
  orders: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** 看板里的一张卡片：任务字段 + 直接子任务的进度计数。 */
export interface BoardTask extends TaskRecord {
  /** 直接子任务中未归档的数量。 */
  childTotal: number;
  /** childTotal 里处于完成列的数量。 */
  childDone: number;
}

export interface BoardColumn {
  id: string;
  name: string;
  orders: number;
  tasks: BoardTask[];
}

/** 列的静态信息（不含该列的任务）。看板接口的列与搜索接口的列字典都是这个形状。 */
export type ColumnRecord = Pick<BoardColumn, 'id' | 'name' | 'orders'>;

export interface Board {
  /** null 表示根看板。 */
  parentId: string | null;
  columns: BoardColumn[];
}

/**
 * 任务树里的一个节点（`GET /api/tree`）。只有建树、画节点与算工期标记需要的字段：
 * 描述与子任务计数在点进它的看板后由看板接口给出，树上的进度徽标是用这份列表就地算的
 * （见 lib/tree.ts 的 countChildren）。
 *
 * 工期与计时三件套必须在树里也带上：看板接口只返回当前这一层，而任务树要画每一层的标记。
 */
export interface TreeTask {
  id: string;
  parentId: string | null;
  title: string;
  columnId: string;
  /** 非空表示已归档。用它把归档节点画成另一种样式。 */
  archivedAt: string | null;
  durationMinutes: number | null;
  spentMinutes: number;
  runningSince: string | null;
}

/** 面包屑的一项。id 为 null 表示根看板，也就是面包屑的第一段。 */
export interface BreadcrumbItem {
  id: string | null;
  title: string;
}

/**
 * 关键路径里的一个任务节点（`GET /api/board[/:parentId]/cpm`）。
 *
 * 前四项是任务字段，`durationMinutes` 保留 null（未估）而不是折成 0：CPM 按 0 算，
 * 但界面要能区分「未估」与「瞬时」。后六项是后端按 CPM 算出的分钟数（相对项目起点）。
 */
export interface ScheduleNode {
  id: string;
  title: string;
  columnId: string;
  durationMinutes: number | null;
  archivedAt: string | null;
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  /** 最晚开始 − 最早开始；0 表示这个任务在关键路径上。 */
  slack: number;
  critical: boolean;
}

/**
 * 依赖图里的一条边：predecessor 完成后 successor 才能开始。
 * `critical` 不只是「两端都关键」，还要求这条边是紧的（见 apps/api/src/domain/cpm.ts）。
 */
export interface ScheduleEdge {
  predecessorId: string;
  successorId: string;
  critical: boolean;
}

/** 某一层的依赖图与关键路径（`GET /api/board[/:parentId]/cpm`）。 */
export interface LayerSchedule {
  /** null 表示根看板。 */
  parentId: string | null;
  /** 该层总工期（分钟）：所有任务最早完成时间的最大值。 */
  projectDuration: number;
  nodes: ScheduleNode[];
  edges: ScheduleEdge[];
}

/**
 * 搜索命中一条任务（`GET /api/search`）。它不是任务记录的子集：
 * 列表要显示的「在哪一层」「为什么命中」都由后端算好，前端不再自己拼。
 */
export interface SearchResult {
  id: string;
  title: string;
  /** 命中在描述里时的一段上下文（含省略号）；只有标题命中时为 null。 */
  snippet: string | null;
  columnId: string;
  /** 工期，单位分钟；null 表示未估。结果行上「未估就不显示工期」用它判断。 */
  durationMinutes: number | null;
  /** 非空表示已归档（只有开着「显示已归档」时才可能命中）。 */
  archivedAt: string | null;
  /** 祖先链，从根看板到该任务的父任务，不含任务自己。 */
  path: BreadcrumbItem[];
}

export interface SearchResponse {
  /**
   * 列字典（列名与顺序）。结果页按列分组，而列名只由后端定，所以跟着结果一起给——
   * 搜索是全库的，不该因为「当前这一层看板取不到」就画不出来。
   */
  columns: ColumnRecord[];
  results: SearchResult[];
  /** 命中数超过后端上限，界面据此提示只显示了一部分。 */
  truncated: boolean;
}
