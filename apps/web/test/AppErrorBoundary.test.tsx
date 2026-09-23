import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from '../src/components/AppErrorBoundary';

/**
 * 整页错误兜底（审计报告 C2）。
 *
 * 没有它时，任何渲染期异常都会让 React 卸载整棵树，页面只剩白屏。这里钉三件事：
 * 正常时什么都不做、抛错时给出可操作的兜底页（而不是白屏）、点「重试」能真的恢复渲染。
 * 兜底页的具体形态属于设计，见 docs/decisions.md D58。
 */

/** 由用例控制什么时候抛：重试之后要能正常渲染，才能证明「重试」不是摆设。 */
let shouldThrow = true;

function Flaky(): React.JSX.Element {
  if (shouldThrow) throw new Error('渲染期炸了');
  return <p>恢复后的界面</p>;
}

const ERROR_SPY = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  shouldThrow = true;
  cleanup();
});

describe('AppErrorBoundary', () => {
  it('子组件正常时不显示兜底页', () => {
    render(
      <AppErrorBoundary>
        <p>正常内容</p>
      </AppErrorBoundary>,
    );

    expect(screen.getByText('正常内容')).toBeTruthy();
    expect(screen.queryByText('界面出错了')).toBeNull();
    expect(ERROR_SPY).not.toHaveBeenCalled();
  });

  it('渲染期抛错时显示兜底页，并把堆栈留给控制台', () => {
    render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('界面出错了')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeTruthy();
    // 定版 A2 不把错误文本搬到页面上（普通用户看不懂），但出错必须留痕，不能静默换个页面。
    expect(screen.queryByText('渲染期炸了')).toBeNull();
    // 断言的是 componentDidCatch 自己那一条：React 也会往 console.error 写，
    // 只断言「被调用过」的话，删掉 componentDidCatch 用例照样绿（审阅实测）。
    expect(ERROR_SPY).toHaveBeenCalledWith(
      '界面渲染失败:',
      expect.anything(),
      expect.anything(),
    );
  });

  it('点「重试」后重新渲染子组件（数据在后端，重取通常就好了）', () => {
    render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );
    expect(screen.getByText('界面出错了')).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(screen.getByText('恢复后的界面')).toBeTruthy();
    expect(screen.queryByText('界面出错了')).toBeNull();
  });
});
