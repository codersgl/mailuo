import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../src/api/types';
import { SearchResults } from '../src/components/SearchResults';
import { groupByColumn } from '../src/domain/search';
import type { SearchState } from '../src/hooks/useSearch';

/**
 * 结果页这一层的渲染：高亮、选中态、工期胶囊、已归档标记、截断提示、失败态。
 * 端到端那条链路（输入 → 结果 → 进入任务）在 App.test.tsx 里，这里只测这棵子树。
 */

function result(overrides: Partial<SearchResult> & Pick<SearchResult, 'id' | 'title'>): SearchResult {
  return {
    snippet: null,
    columnId: 'todo',
    durationMinutes: null,
    archivedAt: null,
    path: [{ id: null, title: '根看板' }],
    ...overrides,
  };
}

const searchColumns = [
  { id: 'todo', name: '待办', orders: 1000 },
  { id: 'doing', name: '进行中', orders: 2000 },
  { id: 'done', name: '完成', orders: 3000 },
];

/** 结果页要的 ready 态：关键词、开关、列字典、结果四样都得有。 */
function ready(
  results: SearchResult[],
  options: { keyword?: string; truncated?: boolean; includeArchived?: boolean } = {},
): SearchState {
  return {
    status: 'ready',
    keyword: options.keyword ?? '登录',
    includeArchived: options.includeArchived ?? false,
    columns: searchColumns,
    results,
    truncated: options.truncated ?? false,
  };
}

/** 与 BoardPage 一样：分组从 state 里的结果算，而不是另传一份。 */
function renderResults(
  state: SearchState,
  options: { selectedIndex?: number } = {},
) {
  const onOpen = vi.fn();
  const onClear = vi.fn();
  const onRetry = vi.fn();
  render(
    <SearchResults
      state={state}
      groups={groupByColumn(
        state.status === 'ready' ? state.results : [],
        state.status === 'ready' ? state.columns : [],
      )}
      selectedIndex={options.selectedIndex ?? 0}
      onOpen={onOpen}
      onClear={onClear}
      onRetry={onRetry}
    />,
  );
  return { onOpen, onClear, onRetry };
}

afterEach(() => {
  cleanup();
});

describe('SearchResults', () => {
  it('命中片段标成 mark，未命中的部分是普通文本', () => {
    renderResults(ready([result({ id: 't1', title: '重构登录页面' })]));

    const marks = document.querySelectorAll('mark');
    expect(Array.from(marks).map((mark) => mark.textContent)).toEqual(['登录']);
    // 标题被 <mark> 切成多段，整句取不到，只能按行按钮的无障碍名字验。
    expect(screen.getByRole('button', { name: /重构登录页面/ })).toBeTruthy();
  });

  it('选中行的 mark 换成 accent-border：选中行底色已经是 accent-weak，同色就看不出来了', () => {
    renderResults(ready([result({ id: 't1', title: '重构登录页面' })]), { selectedIndex: 0 });

    expect(document.querySelector('mark')?.className).toContain('bg-accent-border');
  });

  it('未选中行的 mark 用 accent-weak（选中第一条，第二条就是未选中）', () => {
    renderResults(
      ready([
        result({ id: 't1', title: '登录甲' }),
        result({ id: 't2', title: '登录乙' }),
      ]),
      { selectedIndex: 0 },
    );

    const marks = Array.from(document.querySelectorAll('mark'));
    expect(marks).toHaveLength(2);
    expect(marks[1]?.className).toContain('bg-accent-weak');
  });

  it('只有描述命中时补一行摘要', () => {
    renderResults(
      ready([
        result({ id: 't1', title: '无关标题', snippet: '…先做登录再补测试…' }),
        result({ id: 't2', title: '登录页', snippet: null }),
      ]),
    );

    // 摘要同样被 <mark> 切开，按 textContent 找那一行。
    const snippet = Array.from(document.querySelectorAll('span')).find(
      (node) => node.textContent === '…先做登录再补测试…',
    );
    expect(snippet).toBeTruthy();
    // 两处命中：摘要里的一个、标题里的一个。标题命中的那条没有第二行描述。
    expect(document.querySelectorAll('mark')).toHaveLength(2);
  });

  it('工期只在估过时显示', () => {
    renderResults(
      ready([
        result({ id: 't1', title: '登录甲', durationMinutes: 1440 }),
        result({ id: 't2', title: '登录乙', durationMinutes: null }),
      ]),
    );

    expect(screen.getByText('工期 3 天')).toBeTruthy();
    expect(screen.queryByText('未估工期')).toBeNull();
  });

  it('归档的结果带「已归档」标记', () => {
    renderResults(ready([result({ id: 't1', title: '登录归档版', archivedAt: '2026-09-22T00:00:00.000Z' })]));

    expect(screen.getByText('已归档')).toBeTruthy();
  });

  it('点结果行把任务 id 交给上层', () => {
    const { onOpen } = renderResults(ready([result({ id: 't1', title: '登录页' })]));

    fireEvent.click(screen.getByRole('button', { name: /登录页/ }));

    expect(onOpen.mock.calls).toEqual([['t1']]);
  });

  it('「返回看板」交给上层清空搜索', () => {
    const { onClear } = renderResults(ready([result({ id: 't1', title: '登录页' })]));

    fireEvent.click(screen.getByRole('button', { name: '返回看板' }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('按列分组，每组带自己的计数', () => {
    renderResults(
      ready([
        result({ id: 't1', title: '登录甲', columnId: 'todo' }),
        result({ id: 't2', title: '登录乙', columnId: 'done' }),
        result({ id: 't3', title: '登录丙', columnId: 'done' }),
      ]),
    );

    expect(screen.getByText('待办')).toBeTruthy();
    expect(screen.getByText('完成')).toBeTruthy();
    expect(screen.queryByText('进行中')).toBeNull();
    expect(screen.getByText('2 个')).toBeTruthy();
  });

  it('没有匹配时给空状态，并指向「显示已归档」', () => {
    renderResults(ready([], { keyword: '找不到的词' }));

    expect(screen.getByText('没有匹配「找不到的词」的任务')).toBeTruthy();
    expect(screen.getByText(/显示已归档/)).toBeTruthy();
  });

  it('这批结果是在「显示已归档」开着时搜的，就不再提示去打开它', () => {
    renderResults(ready([], { keyword: '找不到的词', includeArchived: true }));

    expect(screen.getByText('换个更短的关键词再试。')).toBeTruthy();
  });

  it('截断时提示只显示了一部分', () => {
    renderResults(ready([result({ id: 't1', title: '登录页' })], { truncated: true }));

    expect(screen.getByText(/只显示了其中一部分/)).toBeTruthy();
  });

  it('加载中不写「找到 0 个任务」', () => {
    renderResults({ status: 'loading' });

    expect(screen.getByText('搜索中…')).toBeTruthy();
    expect(screen.queryByText(/找到/)).toBeNull();
  });

  it('失败时给出后端文案与重试', () => {
    const { onRetry } = renderResults({ status: 'failed', message: '搜索词最多 100 字' });

    expect(screen.getByText('搜索词最多 100 字')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('跨分组时选中下标按渲染顺序走：高亮的那一行就是 Enter 会打开的那一行', () => {
    renderResults(
      ready(
        [
          result({ id: 't1', title: '登录甲', columnId: 'todo' }),
          result({ id: 't2', title: '登录乙', columnId: 'done' }),
          result({ id: 't3', title: '登录丙', columnId: 'done' }),
        ],
        { keyword: '登录' },
      ),
      { selectedIndex: 1 },
    );

    // 摊平顺序是 甲、乙、丙，所以下标 1 落在「完成」组的第一行「登录乙」上。
    // 分组起点（SearchResults 里的 starts）与 flattenGroups 必须一致，否则 ↓ 高亮的行
    // 和 Enter 打开的行会错位——这是两份独立的下标实现，所以才要钉住。
    const selected = Array.from(document.querySelectorAll('li > button')).filter((button) =>
      button.className.includes('bg-accent-weak'),
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain('登录乙');
  });

  it('无障碍名字由可见文本组成（标题 + 路径 + 工期 + 已归档都在里面）', () => {
    renderResults(
      ready([
        result({
          id: 't1',
          title: '补单元测试',
          path: [
            { id: null, title: '根看板' },
            { id: 'p', title: '重构登录' },
          ],
        }),
      ]),
    );

    // 不设 aria-label：名字就是按钮里看到的东西。同名任务在不同层靠路径区分。
    const row = screen.getByRole('button', { name: /补单元测试/ });
    expect(row.textContent).toContain('根看板 / 重构登录');
  });
});
