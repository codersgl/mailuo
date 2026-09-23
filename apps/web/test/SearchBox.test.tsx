import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchBox } from '../src/components/SearchBox';
import { MAX_QUERY_LENGTH } from '../src/domain/search';

/**
 * SearchBox 是一个受控控件：它不持有状态，只把输入与按键转给上层。
 * 这里测的就是这份转发，以及「有没有清除按钮」这类只有它自己知道的事。
 * 键盘语义（↑↓/Enter/Esc 怎么动选中项）在 App 与 SearchResults 的用例里。
 */

afterEach(() => {
  cleanup();
});

describe('SearchBox', () => {
  it('输入时把新值交给上层', () => {
    const onValueChange = vi.fn();
    render(<SearchBox value="" onValueChange={onValueChange} onKeyDown={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox', { name: '搜索任务' }), {
      target: { value: '登录' },
    });

    expect(onValueChange.mock.calls).toEqual([['登录']]);
  });

  it('按键原样转出去，控件自己不拦', () => {
    const onKeyDown = vi.fn();
    render(<SearchBox value="登录" onValueChange={vi.fn()} onKeyDown={onKeyDown} />);

    fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索任务' }), { key: 'ArrowDown' });

    expect(onKeyDown.mock.calls[0]?.[0]).toMatchObject({ key: 'ArrowDown' });
  });

  it('空框上没有清除按钮', () => {
    render(<SearchBox value="" onValueChange={vi.fn()} onKeyDown={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '清空搜索' })).toBeNull();
  });

  it('有内容时点清除按钮把值清空', () => {
    const onValueChange = vi.fn();
    render(<SearchBox value="登录" onValueChange={onValueChange} onKeyDown={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));

    expect(onValueChange.mock.calls).toEqual([['']]);
  });

  it('长度上限与后端同一个数：靠 maxLength 挡住，而不是让后端回 400', () => {
    render(<SearchBox value="" onValueChange={vi.fn()} onKeyDown={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: '搜索任务' }).getAttribute('maxlength')).toBe(
      String(MAX_QUERY_LENGTH),
    );
  });
});
