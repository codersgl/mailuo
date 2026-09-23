import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DependencySection } from '../src/components/DependencySection';
import type { DependencyCandidateGroup, DependencyCandidateRow } from '../src/domain/layerDeps';

/**
 * 抽屉里「前置任务」区块的行为：分组、勾选、不能选的原因、过滤与空状态。
 * 集合口径（谁能选、谁成环）在 domain/layerDeps.ts 的用例里，这里只钉住「怎么画、怎么报回去」。
 */

function row(id: string, title: string, overrides: Partial<DependencyCandidateRow> = {}) {
  return { id, title, durationMinutes: null, selected: false, blockedReason: null, ...overrides };
}

function group(columnId: string, columnName: string, rows: DependencyCandidateRow[]) {
  return { columnId, columnName, rows };
}

function renderSection(
  groups: DependencyCandidateGroup[],
  overrides: { selectedCount?: number; archivedPredecessorCount?: number } = {},
) {
  const onToggle = vi.fn();
  render(
    <DependencySection
      groups={groups}
      selectedCount={overrides.selectedCount ?? 0}
      archivedPredecessorCount={overrides.archivedPredecessorCount ?? 0}
      onToggle={onToggle}
    />,
  );
  return { onToggle };
}

afterEach(cleanup);

describe('DependencySection', () => {
  it('按列分组列出候选，并显示已选数量与工期', () => {
    renderSection(
      [
        group('doing', '进行中', [row('a', '重构登录', { durationMinutes: 540 })]),
        group('todo', '待办', [row('b', '支付对账')]),
      ],
      { selectedCount: 1 },
    );

    expect(screen.getByRole('heading', { name: '前置任务' })).toBeTruthy();
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    expect(screen.getByText('进行中')).toBeTruthy();
    expect(screen.getByText('待办')).toBeTruthy();
    // 工期用短形式：候选行右侧只有几十像素，不写「工期」前缀。
    expect(screen.getByText('1 天 1 小时')).toBeTruthy();
    expect(screen.getByText('未估')).toBeTruthy();
  });

  it('勾选与取消都按 (任务 id, 目标状态) 报回去', () => {
    const { onToggle } = renderSection([group('todo', '待办', [row('b', '支付对账')])]);

    fireEvent.click(screen.getByRole('checkbox', { name: /支付对账/ }));
    expect(onToggle).toHaveBeenCalledWith('b', true);
  });

  it('已选中的项勾掉时报 false', () => {
    const { onToggle } = renderSection([
      group('todo', '待办', [row('b', '支付对账', { selected: true })]),
    ]);

    fireEvent.click(screen.getByRole('checkbox', { name: /支付对账/ }));
    expect(onToggle).toHaveBeenCalledWith('b', false);
  });

  it('不能选的候选是禁用的，并在行内写明原因', () => {
    renderSection([
      group('todo', '待办', [
        row('c', '老会话兼容层', { blockedReason: '会形成环：它已经依赖本任务' }),
        row('z', '旧版导出', { blockedReason: '已归档' }),
      ]),
    ]);

    const cyclic = screen.getByRole('checkbox', { name: /老会话兼容层/ }) as HTMLInputElement;
    expect(cyclic.disabled).toBe(true);
    expect(cyclic.checked).toBe(false);
    expect(screen.getByText('会形成环：它已经依赖本任务')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /旧版导出/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    // 这里不断言「点了没反应」：jsdom 不实现「禁用的控件不派发 click」这条浏览器行为，
    // 手动 dispatch 出来的事件照样会走到 React 的 onChange。真实浏览器里点不到，键盘也停不下来，
    // 所以这条路径只能靠 disabled 本身保证（上面那两条断言就是它的守卫）。
  });

  it('有已归档的前置时提示保存会解除它；没有时不出现这句话', () => {
    const { unmount } = render(
      <DependencySection
        groups={[group('todo', '待办', [row('b', '支付对账')])]}
        selectedCount={0}
        archivedPredecessorCount={1}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('有 1 个前置任务已归档，保存后这条依赖会被解除')).toBeTruthy();
    unmount();

    renderSection([group('todo', '待办', [row('b', '支付对账')])]);
    expect(screen.queryByText(/已归档，保存后/)).toBeNull();
  });

  it('候选不多时没有过滤框：空控件只是噪音', () => {
    renderSection([group('todo', '待办', [row('b', '支付对账')])]);

    expect(screen.queryByRole('textbox', { name: '过滤同层任务' })).toBeNull();
  });

  it('候选超过 8 条才有过滤框，过滤只减少显示行，不改已选数量', () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      row(`t${index}`, index === 0 ? '登录接口联调' : `任务 ${index}`, {
        selected: index === 0,
      }),
    );
    renderSection([group('todo', '待办', rows)], { selectedCount: 1 });

    const filter = screen.getByRole('textbox', { name: '过滤同层任务' });
    fireEvent.change(filter, { target: { value: '登录' } });

    expect(screen.getByRole('checkbox', { name: /登录接口联调/ })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /任务 3/ })).toBeNull();
    // 过滤不改集合：已选计数与保存时提交的东西都不该跟着变。
    expect(screen.getByText('已选 1 项')).toBeTruthy();
  });

  it('过滤没有命中时给出空状态文案', () => {
    const rows = Array.from({ length: 9 }, (_, index) => row(`t${index}`, `任务 ${index}`));
    renderSection([group('todo', '待办', rows)]);

    fireEvent.change(screen.getByRole('textbox', { name: '过滤同层任务' }), {
      target: { value: '不存在的关键词' },
    });

    expect(screen.getByText('没有匹配的任务')).toBeTruthy();
  });

  it('这一层没有别的任务时不画列表，只给一行说明', () => {
    renderSection([]);

    expect(screen.getByText('这一层还没有别的任务')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('保存进行中时所有候选都点不动：这次提交的是点击那一刻的草稿', () => {
    render(
      <DependencySection
        groups={[group('todo', '待办', [row('b', '支付对账')])]}
        selectedCount={0}
        archivedPredecessorCount={0}
        busy
        onToggle={vi.fn()}
      />,
    );

    const input = screen.getByRole('checkbox', { name: /支付对账/ }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    // 只是暂时点不动，不该像「不能选」那样变淡。
    expect(input.closest('label')?.className).not.toContain('opacity-55');
  });
});
