import type { Db } from '../db/client.js';
import { SEARCH_LIMIT, toLikePattern } from '../domain/search.js';
import type { ColumnRecord } from './columns.js';
import { listColumns } from './columns.js';
import type { BreadcrumbItem } from './tasks.js';
import { TaskCycleError, readBreadcrumb } from './tasks.js';

/** 一条搜索结果。字段是按「结果列表怎么画」定的，不是任务记录的子集。 */
export interface SearchResult {
  id: string;
  title: string;
  /**
   * 匹配发生在描述里时，以关键词为中心的一段上下文（换行已压成空格，两端按需加省略号）。
   * 标题命中而描述里没有关键词时为 null——那种情况下列表只高亮标题，不硬凑一段描述。
   */
  snippet: string | null;
  columnId: string;
  /** 工期，单位分钟；null 表示未估。结果行上「未估就不显示工期」用的是这个字段。 */
  durationMinutes: number | null;
  /** 非空表示该结果已归档（只有开着「显示已归档」时才可能命中）。 */
  archivedAt: string | null;
  /**
   * 祖先链，从根看板到该任务的父任务，不含任务自己（标题就在上一行，再列一遍是重复）。
   * 根层任务只有「根看板」一项。
   */
  path: BreadcrumbItem[];
}

export interface SearchOutcome {
  /**
   * 列字典（id、列名、顺序）。搜索结果按列分组呈现，而列名与列顺序只由后端定
   * （见 docs/spec.md「三列固定」），所以跟着结果一起返回，前端不必再去读一次看板——
   * 搜索是全库的，不该因为「当前这一层看板取不到」而画不出来。
   */
  columns: ColumnRecord[];
  results: SearchResult[];
  /** 命中数超过 SEARCH_LIMIT，界面据此提示只显示了一部分。 */
  truncated: boolean;
}

/** 与 SELECT 列表一一对应的原始行。 */
interface SearchRow {
  id: string;
  title: string;
  description: string;
  column_id: string;
  duration_minutes: number | null;
  archived_at: string | null;
}

/** 描述摘要里关键词两侧各留多少字符。 */
const SNIPPET_RADIUS = 24;

/**
 * 全库搜索：匹配标题与描述，跨层级、不受当前看板限制。
 *
 * 几个口径：
 * - 空关键词不该走到这里（路由层会先回 400），所以这里不特判。
 * - `includeArchived` 沿用所有读接口的开关语义：默认只搜未归档任务。
 * - 排序是「标题命中的排前面」+「最近改过的排前面」。不做相关度打分：
 *   个人规模下，标题命中与否已经是用户能理解的最强信号，再加一套评分只会让人猜不透顺序。
 * - 路径复用 `readBreadcrumb` 沿父链走，而不是写一段递归 SQL 一次算完所有祖先：
 *   结果上限 50 条、层级只有几层，省下的那几次查询换不回来一份重复的递归 CTE。
 * - 父行缺失或父链成环的脏数据只影响那一条结果（路径退化成空），不让整个搜索 500：
 *   搜索是一次跨全库的读，一条坏数据不该把其余几十条正常结果一起挡掉。
 */
export function searchTasks(db: Db, keyword: string, includeArchived = false): SearchOutcome {
  const pattern = toLikePattern(keyword);
  // 多取一条用来判断「还有更多」，比再跑一次 COUNT 便宜，也不会因为并发写入对不上。
  const rows = db
    .prepare(
      `SELECT id, title, description, column_id, duration_minutes, archived_at
       FROM tasks
       WHERE (@includeArchived = 1 OR archived_at IS NULL)
         AND (title LIKE @pattern ESCAPE '\\' OR description LIKE @pattern ESCAPE '\\')
       ORDER BY (title LIKE @pattern ESCAPE '\\') DESC, updated_at DESC, id
       LIMIT @limit`,
    )
    .all({
      pattern,
      includeArchived: includeArchived ? 1 : 0,
      limit: SEARCH_LIMIT + 1,
    }) as SearchRow[];

  return {
    columns: listColumns(db),
    results: rows.slice(0, SEARCH_LIMIT).map((row) => toSearchResult(db, row, keyword)),
    truncated: rows.length > SEARCH_LIMIT,
  };
}

function toSearchResult(db: Db, row: SearchRow, keyword: string): SearchResult {
  return {
    id: row.id,
    title: row.title,
    snippet: buildSnippet(row.description, keyword),
    columnId: row.column_id,
    durationMinutes: row.duration_minutes,
    archivedAt: row.archived_at,
    path: readPath(db, row.id),
  };
}

/** 结果的祖先链：面包屑去掉最后一项（任务自己，标题就在结果行上）。取不到就是空路径。 */
function readPath(db: Db, taskId: string): BreadcrumbItem[] {
  try {
    return readBreadcrumb(db, taskId)?.slice(0, -1) ?? [];
  } catch (error: unknown) {
    // 父链成环（只可能来自手工改库）在面包屑接口里是 500，那是单条任务的读，报错是合理的；
    // 搜索是批量读，一条脏数据退化成「没有路径」比整页报错有用（见上面的说明）。
    if (error instanceof TaskCycleError) return [];
    throw error;
  }
}

/**
 * 描述里以关键词为中心截一段。
 *
 * 先把换行和连续空白压成单个空格再找位置：搜索是单行列表，描述里的换行会把某一行撑高。
 * **关键词也要压**：SQL 是拿原始关键词在原始描述上匹配的，若只在摘要这一侧折叠空白，
 * 搜「目标  乙」（两个空格）会出现「SQL 命中、摘要却找不到关键词」的分叉——
 * 结果是这一行在界面上完全没有高亮，用户看不出它为什么被搜出来。
 *
 * 大小写按 `toLowerCase` 折叠，与 SQL 的 `LIKE`（对 ASCII 不敏感）保持一致，理由同上。
 */
function buildSnippet(description: string, keyword: string): string | null {
  const flat = description.replace(/\s+/g, ' ');
  const needle = keyword.replace(/\s+/g, ' ');
  const index = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return null;

  const start = avoidSurrogateSplit(flat, Math.max(0, index - SNIPPET_RADIUS), 'start');
  const end = avoidSurrogateSplit(
    flat,
    Math.min(flat.length, index + needle.length + SNIPPET_RADIUS),
    'end',
  );
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * 把切点从代理对中间挪开。
 *
 * emoji 这类字符在 JS 字符串里占两个码元（高代理 + 低代理），从中间切断会让界面上渲染成
 * U+FFFD（一个空心方块）。向外挪一格比显示一个坏字符便宜。
 */
function avoidSurrogateSplit(text: string, index: number, edge: 'start' | 'end'): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(edge === 'start' ? index : index - 1);
  const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  if (edge === 'start') return isLowSurrogate ? index - 1 : index;
  return isHighSurrogate ? index + 1 : index;
}
