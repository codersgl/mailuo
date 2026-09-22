import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from '../src/components/TopBar';

/** 面包屑：中间每段可点回上层，最后一段是当前位置、不可点。 */

const crumbs = [
  { id: null, title: '根看板' },
  { id: 'p', title: '重构登录' },
  { id: 'c', title: '前端部分' },
];

describe('TopBar', () => {
  it('除最后一段外都可点，最后一段标成当前位置', () => {
    const onNavigate = vi.fn();
    render(<TopBar crumbs={crumbs} onNavigate={onNavigate} />);

    expect(screen.getAllByText('/')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '根看板' }));
    fireEvent.click(screen.getByRole('button', { name: '重构登录' }));

    expect(onNavigate.mock.calls).toEqual([[null], ['p']]);
    // 当前层是文字而不是按钮：点它没有去处。
    expect(screen.queryByRole('button', { name: '前端部分' })).toBeNull();
    expect(screen.getByText('前端部分').getAttribute('aria-current')).toBe('page');
  });

  it('根看板只有一段时那一段就是当前位置', () => {
    render(<TopBar crumbs={[{ id: null, title: '根看板' }]} onNavigate={vi.fn()} />);

    expect(screen.getByText('根看板').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('/')).toBeNull();
  });

  it('还没拿到面包屑时不画半截内容', () => {
    render(<TopBar crumbs={null} onNavigate={vi.fn()} />);

    expect(screen.queryByText('根看板')).toBeNull();
    expect(screen.getByText('看板')).toBeTruthy();
  });
});

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});
