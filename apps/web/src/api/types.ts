/**
 * 后端看板接口的返回结构（见 docs/spec.md 的 API 契约）。
 * 字段名与后端一致，全 camelCase；数据库的 snake_case 只在后端内部出现。
 */

/** 看板里的一张卡片。 */
export interface BoardTask {
  id: string;
  parentId: string | null;
  columnId: string;
  title: string;
  description: string;
  /** 工期，单位分钟；null 表示未估工期，0 表示瞬时任务。 */
  durationMinutes: number | null;
  orders: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
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

export interface Board {
  /** null 表示根看板。 */
  parentId: string | null;
  columns: BoardColumn[];
}

/**
 * 文件树里的一个节点（`GET /api/tree`）。只有建树需要的字段：描述、工期、
 * 子任务计数都在点进它的看板后由看板接口给出；树上的进度徽标是用这份列表就地算的
 * （见 lib/tree.ts 的 countChildren）。
 */
export interface TreeTask {
  id: string;
  parentId: string | null;
  title: string;
  columnId: string;
  /** 非空表示已归档。用它把归档节点画成另一种样式。 */
  archivedAt: string | null;
}

/** 面包屑的一项。id 为 null 表示根看板，也就是面包屑的第一段。 */
export interface BreadcrumbItem {
  id: string | null;
  title: string;
}
