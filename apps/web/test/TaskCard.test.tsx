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
    render(<TaskCard task={boardTask()} onOpen={onOpen} onEdit={vi.fn()} />);

    fireEvent.click(screen.getByText('灰度开关'));

    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  it('点编辑热区打开面板，不会顺带进入子看板', () => {
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    const task = boardTask();
    render(<TaskCard task={task} onOpen={onOpen} onEdit={onEdit} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑「灰度开关」' }));

    expect(onEdit).toHaveBeenCalledWith(task);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('编辑按钮与卡片主体是两个并列的按钮，不嵌套', () => {
    // 嵌套按钮在 HTML 里是非法的，浏览器会把内层拆出去；这里钉住结构，防止以后改动时踩到。
    render(<TaskCard task={boardTask()} onOpen={vi.fn()} onEdit={vi.fn()} />);

    const edit = screen.getByRole('button', { name: '编辑「灰度开关」' });
    const body = screen.getByText('灰度开关').closest('button')!;

    expect(edit.closest('button')).toBe(edit);
    expect(body.contains(edit)).toBe(false);
    expect(body.parentElement).toBe(edit.parentElement);
  });

  it('标题、描述、进度与工期三态都照口径渲染', () => {
    render(
      <TaskCard
        task={boardTask({ title: '前端表单改造', description: '拆分校验逻辑', durationMinutes: 180, childTotal: 2, childDone: 0 })}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText('前端表单改造')).toBeTruthy();
    expect(screen.getByText('拆分校验逻辑')).toBeTruthy();
    expect(screen.getByText('0/2 子任务')).toBeTruthy();
    expect(screen.getByText('工期 3 小时')).toBeTruthy();
  });

  it('没有描述就不显示描述行', () => {
    render(<TaskCard task={boardTask({ description: '' })} onOpen={vi.fn()} onEdit={vi.fn()} />);

    expect(screen.queryByText('先内部账号生效')).toBeNull();
  });

  it('归档卡片用虚线边框并带「归档」标记', () => {
    render(
      <TaskCard
        task={boardTask({ archivedAt: '2026-09-22T01:00:00.000Z' })}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText('归档')).toBeTruthy();
    expect(screen.getByText('灰度开关').closest('article')?.className).toContain('border-dashed');
  });

  it('未归档卡片不是虚线边框，也没有归档标记', () => {
    render(<TaskCard task={boardTask()} onOpen={vi.fn()} onEdit={vi.fn()} />);

    expect(screen.queryByText('归档')).toBeNull();
    expect(screen.getByText('灰度开关').closest('article')?.className).not.toContain('border-dashed');
  });
});

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});
