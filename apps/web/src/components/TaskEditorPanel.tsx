import { useEffect, useState } from 'react';
import { cx } from '../lib/cx';
import { formatDuration, readDurationInput, splitDuration } from '../lib/format';
import type { DurationParts } from '../lib/format';
import type { TaskFieldsPatch } from '../api/client';
import type { BoardTask } from '../api/types';
import type { DeleteResult, WriteResult } from '../hooks/useTaskActions';

const PRIMARY_BUTTON =
  'h-[26px] rounded-[5px] bg-accent px-2.5 text-[12px] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45';
const SECONDARY_BUTTON =
  'h-[26px] rounded-[5px] border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink';
const DANGER_BUTTON =
  'h-[26px] rounded-[5px] bg-danger px-2.5 text-[12px] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45';
const FIELD_LABEL = 'text-[11.5px] font-semibold text-ink-2';
const FIELD_INPUT =
  'mt-1 w-full rounded-[5px] border border-line bg-surface-2 px-2 py-1 text-[13px] outline-none focus:border-accent-border disabled:cursor-not-allowed disabled:text-ink-3';

/**
 * 任务详情抽屉（定版原型 A）。编辑的是当前看板里的某张卡片，也就是当前看板所在任务的子任务，
 * 所以这里永远不会删掉「正在看的这一层」。
 *
 * 组件内保存着表单的草稿副本，靠父组件的 `key={task.id}` 在换任务时整体重置，
 * 不需要用一个 effect 去同步 props。
 */
export function TaskEditorPanel({
  task,
  onClose,
  onSave,
  onSetArchived,
  onDelete,
}: {
  task: BoardTask;
  onClose: () => void;
  onSave: (patch: TaskFieldsPatch) => Promise<WriteResult>;
  onSetArchived: (archived: boolean) => Promise<WriteResult>;
  onDelete: () => Promise<DeleteResult>;
}) {
  const archived = task.archivedAt !== null;
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [duration, setDuration] = useState<DurationParts>(() => splitDuration(task.durationMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Esc 关闭。焦点可能在抽屉里的任何控件上，所以监听挂在 document 上而不是抽屉上。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const durationInput = readDurationInput(duration);
  const trimmedTitle = title.trim();
  const canSave = trimmedTitle !== '' && durationInput.kind !== 'invalid' && !busy;

  /** 用户一动表单，上一条「已保存」或错误就不再成立。 */
  function markEdited() {
    setSaved(false);
    setError(null);
  }

  function updateDuration(part: keyof DurationParts, value: string) {
    markEdited();
    setDuration((current) => ({ ...current, [part]: value }));
  }

  async function handleSave() {
    if (durationInput.kind === 'invalid' || !canSave) return;

    setBusy(true);
    markEdited();
    const result = await onSave({
      title: trimmedTitle,
      description,
      // 三段全空表示改回「未估工期」（见 docs/decisions.md D32）。
      durationMinutes: durationInput.kind === 'unset' ? null : durationInput.value,
    });
    setBusy(false);
    if (result.ok) setSaved(true);
    else setError(result.message);
  }

  async function handleSetArchived(archivedNext: boolean) {
    setBusy(true);
    markEdited();
    const result = await onSetArchived(archivedNext);
    setBusy(false);
    if (!result.ok) setError(result.message);
  }

  async function handleDelete() {
    setBusy(true);
    markEdited();
    const result = await onDelete();
    setBusy(false);
    // 成功时父组件会把抽屉收起来；失败留在原地报错。
    if (!result.ok) setError(result.message);
  }

  return (
    <div className="absolute inset-0 z-20 flex justify-end">
      {/* 遮罩：点它关闭。用 button 而不是 div，键盘与读屏都能用。 */}
      <button
        type="button"
        aria-label="关闭任务详情"
        onClick={onClose}
        className="absolute inset-0 bg-[rgba(29,33,38,0.28)]"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="任务详情"
        className="relative flex w-[360px] flex-none flex-col border-l border-line bg-surface shadow-[-8px_0_24px_rgba(29,33,38,0.08)]"
      >
        <header className="flex h-[46px] flex-none items-center justify-between border-b border-line px-3.5">
          <h2 className="text-[12.5px] font-semibold">任务详情</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="grid size-5 place-items-center rounded-[4px] text-ink-3 hover:bg-track hover:text-ink"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          {archived && (
            <p className="mb-3 rounded-[5px] border border-dashed border-line-strong px-2 py-1.5 text-[11.5px] text-ink-2">
              这个任务已归档。取消归档后才能改标题、描述与工期。
            </p>
          )}

          <label className="block">
            <span className={FIELD_LABEL}>标题</span>
            <input
              value={title}
              disabled={archived}
              maxLength={200}
              onChange={(event) => {
                markEdited();
                setTitle(event.target.value);
              }}
              className={FIELD_INPUT}
            />
          </label>
          {/* 提示放在 label 外面：否则它会被算进输入框的无障碍名称里，读屏会念成「标题标题不能为空」。 */}
          {trimmedTitle === '' && !archived && (
            <span className="mt-1 block text-[11px] text-danger">标题不能为空</span>
          )}

          <label className="mt-3 block">
            <span className={FIELD_LABEL}>描述</span>
            <textarea
              value={description}
              disabled={archived}
              rows={6}
              maxLength={10000}
              onChange={(event) => {
                markEdited();
                setDescription(event.target.value);
              }}
              placeholder="补充背景、验收标准等"
              className={cx(FIELD_INPUT, 'resize-y leading-[1.5]')}
            />
          </label>

          {/*
            工期用三个输入框而不是「一个数字 + 单位下拉」：3 天 4 小时这种值在单个输入框里
            只能四舍五入，保存时会悄悄改掉工期。空着表示未估，填 0 表示瞬时。
          */}
          <fieldset className="mt-3" disabled={archived}>
            <legend className={FIELD_LABEL}>工期</legend>
            <div className="mt-1 flex items-center gap-2">
              <DurationField
                label="天"
                value={duration.days}
                onChange={(value) => updateDuration('days', value)}
              />
              <DurationField
                label="小时"
                value={duration.hours}
                onChange={(value) => updateDuration('hours', value)}
              />
              <DurationField
                label="分"
                value={duration.minutes}
                onChange={(value) => updateDuration('minutes', value)}
              />
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  markEdited();
                  setDuration({ days: '', hours: '', minutes: '' });
                }}
                className="h-[22px] rounded-[4px] border border-line px-1.5 text-[11px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink"
              >
                未估工期
              </button>
              <button
                type="button"
                onClick={() => {
                  markEdited();
                  setDuration({ days: '', hours: '', minutes: '0' });
                }}
                className="h-[22px] rounded-[4px] border border-line px-1.5 text-[11px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink"
              >
                瞬时
              </button>
              <span className="ml-auto text-[11px] tabular-nums text-ink-3">
                {durationInput.kind === 'invalid'
                  ? '工期必须是整数'
                  : durationInput.kind === 'unset'
                    ? '未估工期'
                    : formatDuration(durationInput.value)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-ink-3">1 天 = 480 分钟（8 小时工作制）</p>
          </fieldset>

          {error !== null && <p className="mt-3 text-[11.5px] text-danger">{error}</p>}
          {saved && <p className="mt-3 text-[11.5px] text-ink-3">已保存</p>}
        </div>

        <footer className="flex-none border-t border-line px-3.5 py-3">
          {archived ? (
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => handleSetArchived(false)}
                className={PRIMARY_BUTTON}
              >
                取消归档
              </button>
              <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
                关闭
              </button>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <button type="button" disabled={!canSave} onClick={handleSave} className={PRIMARY_BUTTON}>
                保存
              </button>
              <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
                取消
              </button>
            </div>
          )}

          {confirmingDelete ? (
            <div className="mt-2.5 flex items-center gap-1.5 border-t border-line pt-2.5">
              <span className="text-[11.5px] text-ink-2">确认删除？会连带删除全部子任务</span>
              <button
                type="button"
                disabled={busy}
                onClick={handleDelete}
                className={cx(DANGER_BUTTON, 'ml-auto')}
              >
                确认删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className={SECONDARY_BUTTON}
              >
                取消
              </button>
            </div>
          ) : (
            <div className="mt-2.5 flex items-center gap-2.5 border-t border-line pt-2.5">
              {/* 归档与删除都保留草稿不提交：它们是「把任务整个收起来 / 清掉」，
                  与标题描述这些字段的改动是两件事。 */}
              <button
                type="button"
                disabled={busy}
                onClick={() => handleSetArchived(true)}
                className="text-[12px] text-ink-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
              >
                归档
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
                className="text-[12px] text-danger hover:underline disabled:cursor-not-allowed disabled:opacity-45"
              >
                删除
              </button>
              <span className="ml-auto text-[10.5px] text-ink-3">删除会连带删除全部子任务</span>
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}

/** 工期的一段输入。用 type="text" + 自己校验：type="number" 会把非法输入直接吞成空串，没法给出提示。 */
function DurationField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="w-14 rounded-[5px] border border-line bg-surface-2 px-2 py-1 text-right text-[12.5px] tabular-nums outline-none focus:border-accent-border disabled:cursor-not-allowed disabled:text-ink-3"
      />
      <span className="text-[11.5px] text-ink-3">{label}</span>
    </label>
  );
}
