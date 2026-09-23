import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { SearchResult } from '../api/types';
import { flattenGroups, formatResultPath, groupStarts } from '../domain/search';
import type { SearchGroup } from '../domain/search';
import type { SearchState } from '../hooks/useSearch';
import { cx } from '../lib/cx';
import { formatDuration } from '../lib/format';
import { splitByKeyword } from '../lib/highlight';
import { ErrorNote, LoadingNote } from './StatusNote';

/**
 * 搜索结果页：有搜索词时整块替换主区（定版原型 C），左侧任务树不动。
 *
 * 行上的键盘选中态只由 `selectedIndex` 决定，焦点留在顶栏的搜索框里——
 * 所以这一块没有自己的键盘处理，按键都在 BoardPage 上（见那里的 handleSearchKeyDown）。
 *
 * 画面上的关键词一律取 `state.keyword`（产生这批结果的那个词），不是输入框里的当前值：
 * 打字有 200ms 防抖，这段窗口里输入框已经变了而结果还是上一批，用输入框的值去高亮/写空状态
 * 会说出「标黄的词并不匹配这一行」「没有匹配「还没搜过的词」的任务」这类假话。
 */
export function SearchResults({
  state,
  groups,
  selectedIndex,
  onOpen,
  onClear,
  onRetry,
}: {
  state: SearchState;
  groups: SearchGroup[];
  selectedIndex: number;
  onOpen: (taskId: string) => void;
  onClear: () => void;
  onRetry: () => void;
}) {
  // 每个分组在摊平顺序里的起始下标，与 flattenGroups 同一份顺序（都在 domain/search.ts）。
  const starts = groupStarts(groups);
  const count = flattenGroups(groups).length;
  const keyword = state.status === 'ready' ? state.keyword : '';

  return (
    <div className="px-4 pb-8 pt-3.5">
      <div className="flex items-center gap-2.5 pb-1">
        {/* aria-live：边打边搜时读屏用户听不到「找到 N 个任务」就成了盲操作。
            整句拼成一个字符串，中间夹 <b> 会让这句话变成「多个元素的文本」。 */}
        <h2 className="text-[13px] font-semibold tabular-nums" aria-live="polite">
          {headerText(state, count)}
        </h2>
        {/* 搜索词回显。accent-weak 是配色里允许的唯一例外色，用来标「这是搜索态」。 */}
        {keyword !== '' && (
          <span className="rounded-[4px] border border-accent-border bg-accent-weak px-1.5 py-px text-[11.5px] text-accent">
            「{keyword}」
          </span>
        )}
        <button
          type="button"
          onClick={onClear}
          className="ml-auto h-[26px] rounded-[5px] border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border"
        >
          返回看板
        </button>
      </div>
      {/* 按键只挂在搜索框上（焦点打字时一直在那里），所以文案把前提写出来，别让人点了空白处再试。 */}
      <p className="mb-1 text-[11px] text-ink-3">
        在搜索框里：↑ ↓ 选择，Enter 进入任务，Esc 返回看板
      </p>

      {state.status === 'failed' && <ErrorNote message={state.message} onRetry={onRetry} />}
      {(state.status === 'loading' || state.status === 'idle') && <LoadingNote />}
      {state.status === 'ready' && state.truncated && (
        <p className="mt-1 text-[11px] text-ink-3">只显示了其中一部分，把关键词写具体些。</p>
      )}
      {state.status === 'ready' && count === 0 && <EmptyState state={state} />}

      {groups.map((group, groupIndex) => (
        <section key={group.columnId} className="mt-2">
          <div className="flex items-center gap-1.5 px-0.5 py-1.5">
            <h3 className="text-[12px] font-semibold tracking-[0.3px] text-ink-2">
              {group.columnName}
            </h3>
            <span className="text-[11px] tabular-nums text-ink-3">{group.results.length} 个</span>
          </div>
          <ul className="flex flex-col gap-1">
            {group.results.map((result, positionInGroup) => (
              <ResultRow
                key={result.id}
                result={result}
                keyword={keyword}
                selected={starts[groupIndex]! + positionInGroup === selectedIndex}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 标题那一行的话。截断时不能只说「找到 N 个」再补一句「还有更多」，两句话会互相打架。 */
function headerText(state: SearchState, count: number): string {
  if (state.status !== 'ready') return '搜索中…';
  return state.truncated ? `找到 ${count} 条以上任务` : `找到 ${count} 个任务`;
}

/**
 * 空状态。第二行按**这批结果**的开关状态说话，不按输入框旁边那个实时开关：
 * 切换开关后结果要 200ms 才回来，用实时的值会让文案先跳一下（说「打开显示已归档试试」而开关已经开了）。
 */
function EmptyState({ state }: { state: Extract<SearchState, { status: 'ready' }> }) {
  return (
    <div className="mt-2.5 rounded-[6px] border border-dashed border-line-strong bg-surface-2 px-4 py-[22px] text-center">
      <p className="text-[13px] text-ink-2">没有匹配「{state.keyword}」的任务</p>
      <p className="mt-1 text-[11px] text-ink-3">
        {/* 没开「显示已归档」时，最常见的「明明有却搜不到」就是把归档任务排除在外，直接给这条出路。 */}
        {state.includeArchived
          ? '换个更短的关键词再试。'
          : '换个更短的关键词，或打开左侧「显示已归档」再试一次。'}
      </p>
    </div>
  );
}

function ResultRow({
  result,
  keyword,
  selected,
  onOpen,
}: {
  result: SearchResult;
  keyword: string;
  selected: boolean;
  onOpen: (taskId: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 选中的行跟着键盘走。jsdom 没有 scrollIntoView，所以按可选方法调用。
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const path = formatResultPath(result);

  return (
    <li>
      {/*
        不给 aria-label：它的优先级高于内容，会把摘要、路径、工期、「已归档」一起挤出无障碍名字
        （实测名字只剩「标题（路径）」）。让按钮的名字直接由可见文本组成，读屏听到的就是看到的。
        已知的取舍：键盘选中态对读屏不可见（没有 listbox/option + aria-activedescendant 那套语义），
        见 docs/decisions.md D45。
      */}
      <button
        ref={ref}
        type="button"
        onClick={() => onOpen(result.id)}
        className={cx(
          // relative 是给选中态左侧那条竖条定位的。
          'relative flex w-full items-center gap-2.5 rounded-[6px] border px-2.5 py-2 text-left',
          selected
            ? 'border-accent-border bg-accent-weak'
            : 'border-line bg-surface hover:border-accent-border',
        )}
      >
        {selected && (
          // 与任务树的选中态同一套语言：accent-weak 底 + 左侧强调色竖条。
          <span
            className="absolute bottom-[5px] left-0 top-[5px] w-0.5 rounded-[1px] bg-accent"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium leading-[1.35]">
            <Highlighted text={result.title} keyword={keyword} selected={selected} />
          </span>
          {/* 命中只在描述里时补一行片段：否则这一条看起来标题里没有搜索词，用户不知道它为什么被搜出来。 */}
          {result.snippet !== null && (
            <span className="mt-0.5 block truncate text-[11.5px] text-ink-2">
              <Highlighted text={result.snippet} keyword={keyword} selected={selected} />
            </span>
          )}
          {path !== '' && (
            <span className="mt-[3px] block truncate text-[11px] text-ink-3">{path}</span>
          )}
        </span>
        {result.archivedAt !== null && (
          <span className="flex-none rounded-[4px] border border-dashed border-line-strong px-1 text-[10px] italic leading-[14px] text-ink-3">
            已归档
          </span>
        )}
        {/* 未估工期就不画这一格：一格写着「未估工期」的胶囊对搜索没有帮助。 */}
        {result.durationMinutes !== null && (
          <span
            className={cx(
              'flex-none whitespace-nowrap rounded-[4px] border border-line px-1.5 text-[11px] leading-4 text-ink-2',
              selected ? 'bg-surface' : 'bg-surface-2',
            )}
          >
            {formatDuration(result.durationMinutes)}
          </span>
        )}
      </button>
    </li>
  );
}

/** 命中片段只改底色与字重，不引入新色相。 */
function Highlighted({
  text,
  keyword,
  selected,
}: {
  text: string;
  keyword: string;
  selected: boolean;
}): ReactNode {
  return splitByKeyword(text, keyword).map((segment, index) =>
    segment.match ? (
      <mark
        key={index}
        // 选中行的底色本身就是 accent-weak，mark 必须换到 accent-border 上才看得出来。
        // text-inherit：<mark> 默认是黑字，深色主题下会变成深底上的黑字。
        className={cx(
          'rounded-[2px] font-semibold text-inherit',
          selected ? 'bg-accent-border' : 'bg-accent-weak',
        )}
      >
        {segment.text}
      </mark>
    ) : (
      <span key={index}>{segment.text}</span>
    ),
  );
}
