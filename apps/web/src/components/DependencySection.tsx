import { useId, useState } from 'react';
import type { DependencyCandidateGroup } from '../domain/layerDeps';
import { filterCandidateGroups } from '../domain/layerDeps';
import { cx } from '../lib/cx';
import { formatDurationShort } from '../lib/format';

/**
 * 候选超过这个数才显示过滤框：这一层通常只有几条，空控件只是噪音。
 * 阈值不是性能考虑（几十条也画得动），是「看不见的控件不该占位置」。
 */
const FILTER_THRESHOLD = 8;

/** 与 TaskEditorPanel 的 FIELD_LABEL 同一套字号与字重：抽屉里的区块标题都长这样。 */
const SECTION_LABEL = 'text-[11.5px] font-semibold text-ink-2';

/**
 * 抽屉里的「前置任务」区块（第 14 步定版原型 A）：同层任务常驻展开为复选列表。
 *
 * 这是**草稿**，不是立即写入：勾选只改这一层的局部状态，点抽屉底部的「保存」才提交，
 * 点「取消」或按 Esc 关闭即整体丢弃——与标题、描述、工期同一个语义。
 *
 * 组件只负责画和报「哪一项被改成什么」，集合口径（谁是当前前置、谁不能选、过滤后还剩什么）
 * 全在 domain/layerDeps.ts 里，可以脱离 DOM 测。
 */
export function DependencySection({
  groups,
  selectedCount,
  archivedPredecessorCount,
  busy = false,
  onToggle,
}: {
  /** 候选，按列分组；含已归档任务（它们的行会写明原因且点不动）。 */
  groups: readonly DependencyCandidateGroup[];
  /** 草稿里已勾选的数量，用来显示标题右侧的「已选 N 项」。 */
  selectedCount: number;
  /** 已归档、但仍挂在本任务上的前置数量；大于 0 时提示保存会解除这些依赖。 */
  archivedPredecessorCount: number;
  /**
   * 一次保存正在进行中。此时所有复选框都禁用：保存提交的是**这次渲染看到的那份草稿**，
   * 中途改动不会被发出去，但界面会显示成已改——用户会以为存上了。禁用比解释便宜。
   * 与「不能选」的禁用分开：这里不加变淡样式，因为它只是暂时的。
   */
  busy?: boolean;
  onToggle: (taskId: string, selected: boolean) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const headingId = useId();
  const listId = useId();

  const totalRows = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const visibleGroups = filterCandidateGroups(groups, keyword);
  const visibleRows = visibleGroups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <section className="mt-3" aria-labelledby={headingId}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 id={headingId} className={SECTION_LABEL}>
          前置任务
        </h3>
        <span className="flex-none text-[11px] tabular-nums text-ink-3">已选 {selectedCount} 项</span>
      </div>
      <p className="mt-0.5 text-[11px] text-ink-3">它们完成后本任务才能开始</p>

      {/*
        已归档的前置不能写回服务端（PUT 会以 400 整份拒绝），所以草稿里本来就不含它们。
        这里必须说清楚：用户只改标题再保存，这条依赖也会被解除。
      */}
      {archivedPredecessorCount > 0 && (
        <p className="mt-1 text-[11px] text-ink-2">
          有 {archivedPredecessorCount} 个前置任务已归档，保存后这条依赖会被解除
        </p>
      )}

      {totalRows === 0 ? (
        <p className="mt-1.5 text-[11.5px] text-ink-3">这一层还没有别的任务</p>
      ) : (
        <>
          {totalRows > FILTER_THRESHOLD && (
            <input
              type="text"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="过滤同层任务"
              aria-label="过滤同层任务"
              aria-controls={listId}
              className="mt-1.5 w-full rounded-[5px] border border-line bg-surface-2 px-2 py-1 text-[12.5px] outline-none focus:border-accent-border"
            />
          )}
          <div
            id={listId}
            className="mt-1.5 max-h-[260px] overflow-y-auto rounded-[5px] border border-line"
          >
            {visibleRows === 0 ? (
              <p className="px-2 py-1.5 text-[11.5px] text-ink-3">没有匹配的任务</p>
            ) : (
              visibleGroups.map((group) => (
                <div key={group.columnId}>
                  {/* sticky：长列表里滚到下半段还能看出这一行属于哪一列。 */}
                  <p className="sticky top-0 bg-surface-2 px-2 py-1 text-[11px] font-semibold text-ink-3">
                    {group.columnName}
                  </p>
                  <div className="px-1 pb-1">
                    {group.rows.map((row) => (
                      <label
                        key={row.id}
                        className={cx(
                          'flex items-start gap-2 rounded-[4px] border-l-2 px-1.5 py-1',
                          // 左侧竖条对所有行都占位（transparent），选中时才上色：否则每次勾选整行会横移 2px。
                          row.selected ? 'border-accent bg-accent-weak' : 'border-transparent',
                          // 不能选的行变淡；保存中的行只是点不动，不加变淡（它马上会恢复）。
                          row.blockedReason !== null
                            ? 'cursor-default opacity-55'
                            : busy
                              ? 'cursor-default'
                              : cx('cursor-pointer', row.selected ? '' : 'hover:bg-surface-2'),
                        )}
                      >
                        <input
                          type="checkbox"
                          // aria-label 是必须的：原因与工期都写在同一个 label 里，不显式给名字的话
                          // 可访问名会变成「标题 会形成环：… 1 天 1 小时」，而它们更适合当描述。
                          aria-label={row.title}
                          checked={row.selected}
                          disabled={row.blockedReason !== null || busy}
                          onChange={(event) => onToggle(row.id, event.target.checked)}
                          aria-describedby={row.blockedReason === null ? undefined : `${row.id}-why`}
                          className="mt-[2px] size-[13px] flex-none accent-accent"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px]">{row.title}</span>
                          {row.blockedReason !== null && (
                            // 原因同时是这段文字的可见内容与复选框的 aria-describedby：
                            // 读屏念成「复选框 标题，不能选，原因」。不要把它算进可访问名
                            // （上面显式给了 aria-label），否则同一句话会被念两遍。
                            <span id={`${row.id}-why`} className="block text-[11px] text-ink-3">
                              {row.blockedReason}
                            </span>
                          )}
                        </span>
                        <span className="flex-none pt-px text-[11px] tabular-nums text-ink-3">
                          {formatDurationShort(row.durationMinutes)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}
