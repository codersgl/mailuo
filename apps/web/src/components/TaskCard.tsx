import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { cx } from '../lib/cx';
import type { BoardTask } from '../api/types';
import { TaskCardFace } from './TaskCardFace';

/**
 * 菜单项外观。拆成「基类 + 颜色」两份常量是必须的：`cx` 只做字符串拼接、不去重，
 * 同一个 CSS 属性写两遍时谁生效由**生成样式表的源序**决定（Tailwind 按 theme key 字母序输出，
 * `.text-danger` 排在 `.text-ink-2` 前面，于是灰色赢），跟 class 书写顺序无关。
 * 所以颜色只能出现一处：普通项用 MENU_ITEM，危险项用 MENU_ITEM_DANGER，不要再 `cx` 叠加。
 */
const MENU_ITEM_BASE = 'block w-full px-2.5 py-1.5 text-left text-[12px]';
const MENU_ITEM = `${MENU_ITEM_BASE} text-ink-2 hover:bg-track hover:text-ink`;
const MENU_ITEM_DANGER = `${MENU_ITEM_BASE} text-danger hover:bg-track hover:text-danger`;

/** 估算的菜单高度，用来判断该向上还是向下展开。 */
const MENU_HEIGHT = 110;

/**
 * 看板里的一张卡片。
 *
 * 卡片主体是一个按钮，点它进入该任务的看板；右上角的「⋯」是它的**兄弟节点**，不能嵌在里面
 * ——两个不同热区必须分得开，否则点操作时会误入下层（见 docs/spec.md 的「界面行为」）。
 * 主体按钮里的子元素全用 span：button 只允许短语内容（phrasing content），塞 div / h3 是无效 HTML。
 *
 * 编辑、归档、删除都收在「⋯」里（定版原型 B）：抽屉只做字段编辑，破坏性与状态类操作留在卡片上。
 * 删除还要就地二次确认。已归档的卡片没有「编辑」——后端对已归档任务的 PATCH 一律拒绝（D16）。
 *
 * 这个弹层是「展开/收起」而不是 ARIA menu：只有三项、Tab 就能走完，而 role="menu" 会连带承诺
 * 方向键导航与焦点管理（还要求子节点只能是 menuitem），不如老老实实用 aria-expanded + 一组按钮。
 */
export function TaskCard({
  task,
  dragging,
  onOpen,
  onEdit,
  onSetArchived,
  onDelete,
  onDragStart,
}: {
  task: BoardTask;
  /** 这张卡片正被拖动：留在原位当占位，内容降透明度。 */
  dragging?: boolean;
  onOpen: (taskId: string) => void;
  onEdit: (task: BoardTask) => void;
  onSetArchived: (task: BoardTask, archived: boolean) => void;
  onDelete: (task: BoardTask) => void;
  /** 在卡片主体或「⋯」上按下时进入拖拽的候选；位移超过阈值才真的开始拖。 */
  onDragStart?: (task: BoardTask, event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const archived = task.archivedAt !== null;
  const startDrag = onDragStart ?? (() => {});

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setConfirmingDelete(false);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    // 默认向下展开；菜单会超出视口底边时改成向上翻（否则会被 main 的滚动区裁掉）。
    // 打开时算一次，之后滚动或改窗高都要重算——只在打开那一刻判断的话，用户滚一下菜单就跑到屏幕外了。
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      setOpenUp(rect.bottom + MENU_HEIGHT > window.innerHeight);
    };
    reposition();

    // 点菜单与触发按钮之外的地方关闭（不铺遮罩：看板其余部分照常可用）。
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    // 滚动事件不冒泡，捕获阶段才能听到 main 的滚动。
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [menuOpen, closeMenu]);

  return (
    <article
      data-task-id={task.id}
      className={cx(
        'relative rounded-[5px] border bg-surface hover:border-accent-border',
        // 归档卡片用虚线边框，和文件树里的归档节点同一套语言。
        archived ? 'border-dashed border-line-strong' : 'border-line',
        // 拖动中的卡片留在原位当占位：内容淡下去，位置不动，免得列里突然空一格。
        dragging && 'opacity-40',
      )}
    >
      <button
        type="button"
        onPointerDown={(event) => startDrag(task, event)}
        onClick={() => onOpen(task.id)}
        className="block w-full cursor-grab rounded-[5px] px-[11px] py-[9px] text-left active:cursor-grabbing"
      >
        <TaskCardFace task={task} archived={archived} />
      </button>

      <button
        ref={triggerRef}
        type="button"
        onPointerDown={(event) => startDrag(task, event)}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
        aria-expanded={menuOpen}
        aria-label={`「${task.title}」的更多操作`}
        className="absolute right-1 top-1 grid size-5 place-items-center rounded-[4px] text-ink-3 hover:bg-track hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-border"
      >
        {/* 三个点：编辑、归档、删除都收在这里。 */}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <circle cx="2.5" cy="6" r="1.1" />
          <circle cx="6" cy="6" r="1.1" />
          <circle cx="9.5" cy="6" r="1.1" />
        </svg>
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className={cx(
            'absolute right-1 z-10 rounded-[5px] border border-line bg-surface py-1 shadow-menu',
            // 向上翻时不写死偏移量，而是按自身高度整体上移：菜单高度随内容变（三项 / 确认态）。
            openUp ? 'top-6 -translate-y-full' : 'top-7',
            confirmingDelete ? 'w-[200px]' : 'w-[132px]',
          )}
        >
          {confirmingDelete ? (
            <div className="px-2.5 py-1">
              <span className="block text-[11.5px] text-ink-2">确认删除？</span>
              <span className="mt-0.5 block text-[10.5px] text-ink-3">会连带删除全部子任务</span>
              <span className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    onDelete(task);
                  }}
                  className="h-[22px] rounded-[4px] bg-danger px-2 text-[11.5px] text-on-fill hover:opacity-90"
                >
                  确认
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="h-[22px] rounded-[4px] border border-line px-2 text-[11.5px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink"
                >
                  取消
                </button>
              </span>
            </div>
          ) : (
            <>
              {!archived && (
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    onEdit(task);
                  }}
                  className={MENU_ITEM}
                >
                  编辑
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  closeMenu();
                  onSetArchived(task, !archived);
                }}
                className={MENU_ITEM}
              >
                {archived ? '取消归档' : '归档'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className={MENU_ITEM_DANGER}
              >
                删除
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
