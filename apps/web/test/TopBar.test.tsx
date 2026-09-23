import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from '../src/components/TopBar';

/** 面包屑：中间每段可点回上层，最后一段是当前位置、不可点。 */

const crumbs = [
  { id: null, title: '根看板' },
  { id: 'p', title: '重构登录' },
  { id: 'c', title: '前端部分' },
];

/** 面包屑那一块。顶栏右端还有搜索框与主题控件，按名字断言时要把它排除掉。 */
const breadcrumb = () => within(screen.getByRole('navigation', { name: '面包屑' }));

/** 搜索框的受控 props。它自己的行为在 SearchBox.test.tsx 里测，这里只关心它被摆进了顶栏。 */
const searchProps = { keyword: '', onKeywordChange: vi.fn(), onKeyDown: vi.fn() };

describe('TopBar', () => {
  it('除最后一段外都可点，最后一段标成当前位置', () => {
    const onNavigate = vi.fn();
    render(<TopBar crumbs={crumbs} onNavigate={onNavigate} search={searchProps} />);

    expect(screen.getAllByText('/')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '根看板' }));
    fireEvent.click(screen.getByRole('button', { name: '重构登录' }));

    expect(onNavigate.mock.calls).toEqual([[null], ['p']]);
    // 当前层是文字而不是按钮：点它没有去处。
    expect(breadcrumb().queryByRole('button', { name: '前端部分' })).toBeNull();
    expect(screen.getByText('前端部分').getAttribute('aria-current')).toBe('page');
  });

  it('根看板只有一段时那一段就是当前位置', () => {
    render(<TopBar crumbs={[{ id: null, title: '根看板' }]} onNavigate={vi.fn()} search={searchProps} />);

    expect(screen.getByText('根看板').getAttribute('aria-current')).toBe('page');
    expect(breadcrumb().queryAllByRole('button')).toHaveLength(0);
    expect(breadcrumb().queryByText('/')).toBeNull();
  });

  it('还没拿到面包屑时不画半截内容', () => {
    render(<TopBar crumbs={null} onNavigate={vi.fn()} search={searchProps} />);

    expect(screen.queryByText('根看板')).toBeNull();
    // 品牌就是页面的 h1（见组件里的注释），所以按 heading 角色断言，而不是按文本存在性。
    expect(screen.getByRole('heading', { name: '脉络' })).toBeTruthy();
  });

  it('右端带主题控件（控件本身的行为在 ThemeToggle.test.tsx）', () => {
    render(<TopBar crumbs={null} onNavigate={vi.fn()} search={searchProps} />);

    expect(screen.getByRole('group', { name: '主题' })).toBeTruthy();
  });
});

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});
