import type { BoardColumn, SearchResult } from '../api/types';

/**
 * 搜索结果页的纯逻辑：分组、扁平化、键盘选中项的移动。
 * 抽出来是为了能在 jsdom 之外单独测——组件里只负责画。
 */

/**
 * 搜索词长度上限，100 字。
 * 后端 `apps/api/src/domain/search.ts` 的 `MAX_QUERY_LENGTH` 是同一个数：那边拒绝（400），
 * 这边让输入框根本敲不进去。分工与工期上限一样（见 docs/decisions.md D40）。
 */
export const MAX_QUERY_LENGTH = 100;

export interface SearchGroup {
  columnId: string;
  columnName: string;
  results: SearchResult[];
}

/**
 * 按列分组。组的顺序照看板的列顺序（待办、进行中、完成），不是按命中数排：
 * 列名与列顺序一律由后端给（见 domain/columns.ts 的说明），前端不自己定序。
 * 空组直接丢掉，否则「完成」那一组会以空标题占掉半屏。
 */
export function groupByColumn(
  results: SearchResult[],
  columns: Array<Pick<BoardColumn, 'id' | 'name'>>,
): SearchGroup[] {
  return columns
    .map((column) => ({
      columnId: column.id,
      columnName: column.name,
      results: results.filter((result) => result.columnId === column.id),
    }))
    .filter((group) => group.results.length > 0);
}

/** 分组的渲染顺序摊平。键盘的 ↑↓ 走的就是这个顺序，所以必须与画出来的顺序一致。 */
export function flattenGroups(groups: SearchGroup[]): SearchResult[] {
  return groups.flatMap((group) => group.results);
}

/**
 * 每个分组在摊平顺序里的起始下标，与 `flattenGroups` 同一份顺序。
 *
 * 键盘选中项用的是摊平下标，渲染时又要知道每一组从第几行开始；这两件事必须用同一个算法，
 * 否则会出现「↓ 高亮的那一行 ≠ Enter 打开的那一行」。所以放在一起，组件不再自己数一遍。
 */
export function groupStarts(groups: SearchGroup[]): number[] {
  const starts: number[] = [];
  let running = 0;
  for (const group of groups) {
    starts.push(running);
    running += group.results.length;
  }
  return starts;
}

/**
 * 移动键盘选中项，返回新下标。上下都不环绕：到顶再按 ↑ 停住，到底再按 ↓ 也停住。
 * 结果为空时返回 -1（没有选中项），这样 Enter 不会误开某一条。
 */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(Math.max(current + delta, 0), count - 1);
}

/** 键盘选中项，以及它属于哪一批结果。 */
export interface ResultSelection {
  /** 批次身份：直接用 `useSearch` 的 state 对象本身。 */
  batch: unknown;
  index: number;
}

/**
 * 选中项在当前这批结果里的下标；批次对不上就当没选过（回到第一条）。
 *
 * 「结果换了就把选中项拉回第一条」原来是用 `useEffect([search.state])` 事后把 state 写回 0。
 * 那是 passive effect，会在结果已经画出来之后才 flush：这段窗口里如果用户（或端到端用例）已经
 * 按了 ↓，这次写入会把刚选中的第二行覆盖回第一行——偶发，机器越忙窗口越大（D74 的偶发红就是
 * 这么来的）。把批次记在选中项里、在渲染时判定，就没有这个窗口了。
 */
export function resolveSelection(selection: ResultSelection, batch: unknown): number {
  return selection.batch === batch ? selection.index : 0;
}

/** 结果行上的层级路径，例如「根看板 / 重构登录 / 前端部分」。路径取不到时是空串。 */
export function formatResultPath(result: SearchResult): string {
  return result.path.map((item) => item.title).join(' / ');
}
