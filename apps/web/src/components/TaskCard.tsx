import { useCallback, useEffect, useRef, useState } from 'react';
import { DONE_COLUMN_ID } from '../domain/columns';
import { cx } from '../lib/cx';
import { formatDuration, formatProgress, isDurationEstimated, progressPercent } from '../lib/format';
import type { BoardTask } from '../api/types';

/** 菜单项的统一外观。写成常量是为了让 Tailwind 扫描到完整类名。 */
const MENU_ITEM =
  'block w-full px-2.5 py-1.5 text-left text-[12px] text-ink-2 hover:bg-track hover:text-ink';

/** 估算的菜单高度，用来判断该向上还是向下展开。 */
const MENU_HEIGHT = 110;

/**
 * 看板里的一张卡片。
 *
 * 卡片主体是一个按钮，点它进入该任务的看板；右上角的「⋯」是它的**兄弟节点**，不能嵌在里面
 * ——两个不同热区必须分得开，否则点操作时会误入下层（见 docs/spec.md 的「界面行为」）。
 * 主体按钮里的子元素全用 span：button 只允许短语内容（phrasing content），塞 div / h3 是无效 HTML。
 *
 * 编辑、归档、删除都收在「⋯」菜单里（定版原型 B）：抽屉只做字段编辑，破坏性与状态类操作留在卡片上。
 * 菜单里的删除还要就地二次确认。已归档的卡片没有「编辑」——后端对已归档任务的 PATCH 一律拒绝（D16）。
 */
export function TaskCard({
  task,
  onOpen,
  onEdit,
  onSetArchived,
  onDelete,
}: {
  task: BoardTask;
  onOpen: (taskId: string) => void;
  onEdit: (task: BoardTask) => void;
  onSetArchived: (task: BoardTask, archived: boolean) => void;
  onDelete: (task: BoardTask) => void;
}) {
  const isDone = task.columnId === DONE_COLUMN_ID;
  const estimated = isDurationEstimated(task.durationMinutes);
  const archived = task.archivedAt !== null;

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setConfirmingDelete(false);
  }, []);

  function openMenu() {
    // 默认向下展开；卡片贴近视口底部时向上翻，免得菜单被 main 的滚动区裁掉。
    const rect = triggerRef.current?.getBoundingClientRect();
    setOpenUp(rect !== undefined && rect.bottom + MENU_HEIGHT > window.innerHeight);
    setMenuOpen(true);
  }

  useEffect(() => {
    if (!menuOpen) return;
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
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen, closeMenu]);

  return (
    <article
      className={cx(
        'relative rounded-[5px] border bg-surface hover:border-accent-border',
        // 归档卡片用虚线边框，和文件树里的归档节点同一套语言。
        archived ? 'border-dashed border-line-strong' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="block w-full rounded-[5px] px-[11px] py-[9px] text-left"
      >
        {/* pr-5 给右上角的「⋯」让出位置，长标题不会跑到它下面。 */}
        <span
          className={cx(
            'block pr-5 text-[13px] leading-[1.35]',
            isDone ? 'font-medium text-ink-2' : 'font-semibold',
          )}
        >
          {task.title}
        </span>

        {/* 没有描述就整行不显示，而不是显示一个占位词（原型 A 的做法）。 */}
        {task.description !== '' && (
          <span className="mt-[3px] block truncate text-[12px] text-ink-2">
            {task.description}
          </span>
        )}

        <span className="mt-2 flex items-center gap-2">
          {/* 进度条是纯装饰，信息由旁边「1/2 子任务」的文字表达。 */}
          <span
            className="h-[3px] w-14 flex-none overflow-hidden rounded-[2px] bg-track"
            aria-hidden="true"
          >
            <i
              className="block h-full rounded-[2px] bg-accent"
              style={{ width: `${progressPercent(task.childDone, task.childTotal)}%` }}
            />
          </span>
          <span className={cx('text-[11px] tabular-nums', isDone ? 'text-accent' : 'text-ink-3')}>
            {formatProgress(task.childDone, task.childTotal)}
          </span>
          <span
            className={cx(
              'ml-auto flex-none whitespace-nowrap rounded-[4px] border px-1.5 text-[11px] leading-4',
              estimated
                ? 'border-line bg-surface-2 text-ink-2'
                : 'border-dashed border-line-strong bg-transparent text-ink-3',
            )}
          >
            {formatDuration(task.durationMinutes)}
          </span>
          {/* 归档标记跟在工期后面（与文件树一样靠右），不挤占标题那一行和右上角的「⋯」。 */}
          {archived && (
            <span className="flex-none rounded-[4px] border border-dashed border-line-strong px-1 text-[10px] italic leading-[14px] text-ink-3">
              归档
            </span>
          )}
        </span>
      </button>

      <button
        ref={triggerRef}
        type="button"
        onClick={() => (menuOpen ? closeMenu() : openMenu())}
        aria-haspopup="menu"
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
          role="menu"
          aria-label={`「${task.title}」的更多操作`}
          className={cx(
            'absolute right-1 z-10 rounded-[5px] border border-line bg-surface py-1 shadow-[0_6px_16px_rgba(29,33,38,0.12)]',
            openUp ? 'bottom-7' : 'top-7',
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
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    onDelete(task);
                  }}
                  className="h-[22px] rounded-[4px] bg-danger px-2 text-[11.5px] text-white hover:opacity-90"
                >
                  确认
                </button>
                <button
                  type="button"
                  role="menuitem"
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
                  role="menuitem"
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
                role="menuitem"
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
                role="menuitem"
                onClick={() => setConfirmingDelete(true)}
                className={cx(MENU_ITEM, 'text-danger hover:text-danger')}
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
