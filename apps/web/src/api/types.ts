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
