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
    spentMinutes: 0,
    runningSince: null,
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
      nowMs={Date.now()}
      onOpen={onOpen}
      onEdit={onEdit}
      onSetArchived={onSetArchived}
      onDelete={onDelete}
    />,
  );
  return { task, onOpen, onEdit, onSetArchived, onDelete };
}

/** 「⋯」按钮。弹层是否打开看它的 aria-expanded，不再依赖 role=menu。 */
function trigger(title = '灰度开关'): HTMLElement {
  return screen.getByRole('button', { name: `「${title}」的更多操作` });
}

function isOpen(title = '灰度开关'): boolean {
  return trigger(title).getAttribute('aria-expanded') === 'true';
}

function openMenu(title = '灰度开关'): void {
  fireEvent.click(trigger(title));
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

    const body = screen.getByText('灰度开关').closest('button')!;

    expect(trigger().closest('button')).toBe(trigger());
    expect(body.contains(trigger())).toBe(false);
    expect(body.parentElement).toBe(trigger().parentElement);
  });

  it('弹层默认收起，点 ⋯ 展开，再点收起', () => {
    renderCard();

    expect(isOpen()).toBe(false);
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();

    openMenu();
    expect(isOpen()).toBe(true);
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();

    fireEvent.click(trigger());
    expect(isOpen()).toBe(false);
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });

  it('未归档卡片的弹层是 编辑 / 归档 / 删除', () => {
    renderCard();
    openMenu();

    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '归档' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });

  it('点「编辑」打开抽屉并收起弹层，不会顺带进入子看板', () => {
    const { task, onEdit, onOpen } = renderCard();
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    expect(onEdit).toHaveBeenCalledWith(task);
    expect(onOpen).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it('点「归档」把归档后的目标状态交给上层', () => {
    const { task, onSetArchived } = renderCard();
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: '归档' }));

    expect(onSetArchived).toHaveBeenCalledWith(task, true);
    expect(isOpen()).toBe(false);
  });

  it('归档卡片的弹层没有「编辑」，给出的是「取消归档」', () => {
    const { task, onSetArchived } = renderCard({ archivedAt: '2026-09-22T01:00:00.000Z' });
    openMenu();

    // 已归档的任务后端不接受字段改动（D16），所以卡片上不给编辑入口。
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '取消归档' }));

    expect(onSetArchived).toHaveBeenCalledWith(task, false);
  });

  it('「删除」要先就地确认，确认才真的删', () => {
    const { task, onDelete } = renderCard();
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    // 弹层就地变成确认，不弹浏览器原生 confirm，也还没发出删除。
    expect(screen.getByText('确认删除？')).toBeTruthy();
    expect(screen.getByText('会连带删除全部子任务')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    expect(onDelete).toHaveBeenCalledWith(task);
    expect(isOpen()).toBe(false);
  });

  it('确认行里点「取消」回到菜单项，不删除', () => {
    const { onDelete } = renderCard();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });

  it('关掉再打开弹层，删除确认态被重置', () => {
    renderCard();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByText('确认删除？')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    openMenu();

    expect(screen.queryByText('确认删除？')).toBeNull();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });

  it('点弹层外面或按 Esc 都会收起', () => {
    renderCard();

    openMenu();
    fireEvent.mouseDown(document.body);
    expect(isOpen()).toBe(false);

    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isOpen()).toBe(false);
  });

  it('标题、描述与进度照口径渲染；有子任务的卡片不画工期胶囊', () => {
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
    // 父任务的列由子任务推导、表也是停的，它自己的工期估算没有展示口径（见 D76）。
    expect(screen.queryByText('工期 3 小时')).toBeNull();
  });

  it('叶子卡片照旧显示工期胶囊', () => {
    renderCard({ durationMinutes: 180 });

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

  it('能拖的卡片给抓手光标', () => {
    renderCard();

    expect(screen.getByText('灰度开关').closest('button')?.className).toContain('cursor-grab');
  });

  it('有子任务的卡片不给抓手光标：拖不动的卡片不做「这里能拖」的承诺', () => {
    renderCard({ childTotal: 2, childDone: 0 });

    const body = screen.getByText('灰度开关').closest('button')!;
    expect(body.className).toContain('cursor-pointer');
    expect(body.className).not.toContain('cursor-grab');
  });

  it('卡片根元素不能加 overflow-hidden：右上角的「⋯」菜单要能伸出卡片', () => {
    // 工期进度条贴着卡片下沿画，最容易顺手给卡片加 overflow-hidden 去剪那 5px 圆角——
    // 那会连带把伸出卡片的菜单一起裁掉（审阅在真实浏览器里量过：加了之后菜单项中心命中的是 BODY）。
    // 圆角由进度条自己带 rounded-b-[4px] 解决，卡片的 overflow 必须保持 visible。
    renderCard();

    const article = screen.getByText('灰度开关').closest('article')!;
    expect(article.className).not.toContain('overflow-hidden');
  });
});

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});
