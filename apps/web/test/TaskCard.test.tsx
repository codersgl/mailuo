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

/** 渲染一张卡片，四个回调都换成探针。 */
function renderCard(overrides: Partial<BoardTask> = {}) {
  const task = boardTask(overrides);
  const onOpen = vi.fn();
  const onEdit = vi.fn();
  const onSetArchived = vi.fn();
  const onDelete = vi.fn();
  render(
    <TaskCard
      task={task}
      onOpen={onOpen}
      onEdit={onEdit}
      onSetArchived={onSetArchived}
      onDelete={onDelete}
    />,
  );
  return { task, onOpen, onEdit, onSetArchived, onDelete };
}

/** 打开「⋯」菜单。 */
function openMenu(title = '灰度开关') {
  fireEvent.click(screen.getByRole('button', { name: `「${title}」的更多操作` }));
}

describe('TaskCard', () => {
  it('点卡片主体进入该任务的看板', () => {
    const { onOpen } = renderCard();

    fireEvent.click(screen.getByText('灰度开关'));

    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  it('⋯ 与卡片主体是两个并列的按钮，不嵌套', () => {
    // 嵌套按钮在 HTML 里是非法的，浏览器会把内层拆出去；这里钉住结构，防止以后改动时踩到。
    renderCard();

    const trigger = screen.getByRole('button', { name: '「灰度开关」的更多操作' });
    const body = screen.getByText('灰度开关').closest('button')!;

    expect(trigger.closest('button')).toBe(trigger);
    expect(body.contains(trigger)).toBe(false);
    expect(body.parentElement).toBe(trigger.parentElement);
  });

  it('菜单默认收起，点 ⋯ 展开，再点收起', () => {
    renderCard();
    const trigger = screen.getByRole('button', { name: '「灰度开关」的更多操作' });

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    openMenu();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('未归档卡片的菜单是 编辑 / 归档 / 删除', () => {
    renderCard();
    openMenu();

    expect(screen.getByRole('menuitem', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '归档' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeTruthy();
  });

  it('点「编辑」打开抽屉并收起菜单，不会顺带进入子看板', () => {
    const { task, onEdit, onOpen } = renderCard();
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: '编辑' }));

    expect(onEdit).toHaveBeenCalledWith(task);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('点「归档」把归档后的目标状态交给上层', () => {
    const { task, onSetArchived } = renderCard();
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));

    expect(onSetArchived).toHaveBeenCalledWith(task, true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('归档卡片的菜单没有「编辑」，给出的是「取消归档」', () => {
    const { task, onSetArchived } = renderCard({ archivedAt: '2026-09-22T01:00:00.000Z' });
    openMenu();

    // 已归档的任务后端不接受字段改动（D16），所以卡片上不给编辑入口。
    expect(screen.queryByRole('menuitem', { name: '编辑' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '取消归档' }));

    expect(onSetArchived).toHaveBeenCalledWith(task, false);
  });

  it('「删除」要先就地确认，确认才真的删', () => {
    const { task, onDelete } = renderCard();
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));

    // 菜单就地变成确认，不弹浏览器原生 confirm，也还没发出删除。
    expect(screen.getByText('确认删除？')).toBeTruthy();
    expect(screen.getByText('会连带删除全部子任务')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: '确认' }));

    expect(onDelete).toHaveBeenCalledWith(task);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('确认行里点「取消」回到菜单项，不删除', () => {
    const { onDelete } = renderCard();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));

    fireEvent.click(screen.getByRole('menuitem', { name: '取消' }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeTruthy();
  });

  it('点菜单外面或按 Esc 都会收起菜单', () => {
    renderCard();

    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('标题、描述、进度与工期三态都照口径渲染', () => {
    renderCard({
      title: '前端表单改造',
      description: '拆分校验逻辑',
      durationMinutes: 180,
      childTotal: 2,
      childDone: 0,
    });

    expect(screen.getByText('前端表单改造')).toBeTruthy();
    expect(screen.getByText('拆分校验逻辑')).toBeTruthy();
    expect(screen.getByText('0/2 子任务')).toBeTruthy();
    expect(screen.getByText('工期 3 小时')).toBeTruthy();
  });

  it('没有描述就不显示描述行', () => {
    renderCard({ description: '' });

    expect(screen.queryByText('先内部账号生效')).toBeNull();
  });

  it('归档卡片用虚线边框并带「归档」标记', () => {
    renderCard({ archivedAt: '2026-09-22T01:00:00.000Z' });

    expect(screen.getByText('归档')).toBeTruthy();
    expect(screen.getByText('灰度开关').closest('article')?.className).toContain('border-dashed');
  });

  it('未归档卡片不是虚线边框，也没有归档标记', () => {
    renderCard();

    expect(screen.queryByText('归档')).toBeNull();
    expect(screen.getByText('灰度开关').closest('article')?.className).not.toContain('border-dashed');
  });
});

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});
