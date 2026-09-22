import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskCard } from '../src/components/TaskCard';
import type { BoardTask } from '../src/api/types';

function boardTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 't1',
    parentId: null,
    columnId: 'todo',
    title: '灰度开关',
    description: '先内部账号生效',
    durationMinutes: null,
    orders: 1000,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    archivedAt: null,
    childTotal: 0,
    childDone: 0,
    ...overrides,
  };
}

describe('TaskCard', () => {
  it('点卡片主体进入该任务的看板', () => {
    const onOpen = vi.fn();
    render(<TaskCard task={boardTask()} onOpen={onOpen} />);

    fireEvent.click(screen.getByText('灰度开关'));

    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  it('标题、描述、进度与工期三态都照口径渲染', () => {
    render(
      <TaskCard
        task={boardTask({ title: '前端表单改造', description: '拆分校验逻辑', durationMinutes: 180, childTotal: 2, childDone: 0 })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('前端表单改造')).toBeTruthy();
    expect(screen.getByText('拆分校验逻辑')).toBeTruthy();
    expect(screen.getByText('0/2 子任务')).toBeTruthy();
    expect(screen.getByText('工期 3 小时')).toBeTruthy();
  });

  it('没有描述就不显示描述行', () => {
    render(<TaskCard task={boardTask({ description: '' })} onOpen={vi.fn()} />);

    expect(screen.queryByText('先内部账号生效')).toBeNull();
  });
});

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});
