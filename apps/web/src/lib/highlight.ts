/**
 * 搜索结果里的关键词高亮。
 *
 * 高亮是纯字符串切分，不碰 DOM：切出来的片段交给组件渲染成 `<mark>`，
 * 于是「怎么切」可以单独测（组件里塞 innerHTML 既危险又测不了）。
 */

export interface HighlightSegment {
  text: string;
  /** true 表示这一段就是命中的关键词。 */
  match: boolean;
}

/**
 * 按关键词把文本切成命中/未命中的片段。关键词为空或整段没有命中时返回一段未命中。
 *
 * 大小写折叠与后端的 `LIKE` 对齐（ASCII 不敏感），否则会出现「后端说命中、界面却不标黄」。
 * 逐位置比窗口而不是先 `toLowerCase()` 出一份副本：有些字符（如 'İ'）折叠后长度会变，
 * 副本上的下标落回原文就会错位。标题与摘要都很短，这点代价换的是切片永远不错位。
 *
 * 关键词里有连续空白时会退化成「把两边空白都折叠成单空格再匹配」：后端的摘要是折叠过的
 * （`repositories/search.ts` 的 buildSnippet），拿原始关键词去匹配折叠文本会整行一个标黄都没有——
 * 那正是搜索最不该出现的状态。折叠只改空白，渲染出来与原文看不出差别（HTML 本来就会合并空白）。
 */
export function splitByKeyword(text: string, keyword: string): HighlightSegment[] {
  if (text === '') return [];

  const needle = keyword.trim().toLowerCase();
  if (needle === '') return [{ text, match: false }];

  const exact = splitExact(text, needle);
  if (exact !== null) return exact;

  // 两边都折叠一次再试。只要有一侧真的变了就值得试：文本可能本来就是单空格（后端摘要的形态），
  // 而关键词里带了连续空白——那时折叠文本没变、折叠关键词变了，仍然能命中。
  const foldedText = text.replace(/\s+/g, ' ');
  const foldedNeedle = needle.replace(/\s+/g, ' ');
  if (foldedText === text && foldedNeedle === needle) return [{ text, match: false }];
  return splitExact(foldedText, foldedNeedle) ?? [{ text, match: false }];
}

/** 精确（大小写不敏感）切分；没有任何命中时返回 null，让调用方决定要不要退化。 */
function splitExact(text: string, needle: string): HighlightSegment[] | null {
  const segments: HighlightSegment[] = [];
  let from = 0;
  for (;;) {
    const index = indexOfIgnoreCase(text, needle, from);
    if (index < 0) break;
    if (index > from) segments.push({ text: text.slice(from, index), match: false });
    segments.push({ text: text.slice(index, index + needle.length), match: true });
    from = index + needle.length;
  }
  if (segments.length === 0) return null;
  if (from < text.length) segments.push({ text: text.slice(from), match: false });
  return segments;
}

/** 从 from 起找 needle 的位置，大小写不敏感；找不到返回 -1。 */
function indexOfIgnoreCase(text: string, needle: string, from: number): number {
  const last = text.length - needle.length;
  for (let index = from; index <= last; index += 1) {
    if (text.slice(index, index + needle.length).toLowerCase() === needle) return index;
  }
  return -1;
}
