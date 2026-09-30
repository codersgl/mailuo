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

  it('没传 onDragStart 时按下卡片不抛错，点击照常进入看板', () => {
    // onDragStart 是可选回调（卡片外壳也被非拖拽场景渲染）。缺失时 startDrag 必须退化成空操作，
    // 不能把 undefined 当函数调用——那会在用户一按下卡片时就炸掉整块看板。
    const { onOpen } = renderCard();
    const body = screen.getByText('灰度开关').closest('button')!;

    fireEvent.pointerDown(body, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(document, { clientX: 10, clientY: 10 });
    fireEvent.click(body);

    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  it('在弹层内部按下不关闭弹层：菜单项的 mousedown 不能被当成「点外面」', () => {
    // 关闭监听挂在 document 上，先于菜单项的 click 收到 mousedown；不排除菜单内部的话，
    // 用户还没抬起手指菜单就已经消失，归档 / 删除根本点不到。
    renderCard();
    openMenu();

    fireEvent.mouseDown(screen.getByRole('button', { name: '归档' }));

    expect(isOpen()).toBe(true);
    expect(screen.getByRole('button', { name: '归档' })).toBeTruthy();
  });

  it('在「⋯」触发按钮上按下也不关闭弹层', () => {
    // 触发按钮在弹层之外（两个是兄弟节点），但它是开关本身：再按一次该由 click 切换收起，
    // mousedown 先关一次会让「再点收起」变成「关了又开」。
    renderCard();
    openMenu();

    fireEvent.mouseDown(trigger());

    expect(isOpen()).toBe(true);
  });

  it('弹层开着时按非 Esc 键不关闭，Esc 才关闭', () => {
    renderCard();
    openMenu();

    // 键盘监听挂在 document 上，任意按键都会进来：不判 key 的话按一下方向键菜单就没了。
    fireEvent.keyDown(document, { key: 'a' });

    expect(isOpen()).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(isOpen()).toBe(false);
  });

  it('触发按钮贴近视口底边时菜单向上翻，视口变化后会重新判断落向', () => {
    // jsdom 的 getBoundingClientRect 全是 0，触发按钮永远「贴着视口顶边」；这里给一个接近底边的假矩形。
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ bottom: window.innerHeight - 4 } as DOMRect);
    try {
      renderCard();
      openMenu();

      const menu = document.querySelector('.shadow-menu')!;
      // 向上时按自身高度整体上移（-translate-y-full），而不是写死偏移：菜单高随内容变（三项 / 确认态）。
      expect(menu.className).toContain('-translate-y-full');
      expect(menu.className).not.toContain('top-7');

      // 窗口变高 / 滚动之后要重算：只在打开那一刻判一次的话，用户滚一下菜单就跑到屏幕外了。
      rect.mockReturnValue({ bottom: 0 } as DOMRect);
      fireEvent(window, new Event('resize'));

      expect(document.querySelector('.shadow-menu')!.className).toContain('top-7');
    } finally {
      rect.mockRestore();
    }
  });
});

afterEach(() => {
  // vitest 没开 globals，@testing-library 的自动清理不会注册，这里手动清 DOM。
  cleanup();
});
