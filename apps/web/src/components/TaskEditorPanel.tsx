import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { cx } from '../lib/cx';
import {
  MAX_DURATION_MINUTES,
  MINUTES_PER_DAY,
  formatDuration,
  readDurationInput,
  splitDuration,
} from '../lib/format';
import type { DurationParts } from '../lib/format';
import type { TaskFieldsPatch } from '../api/client';
import type { BoardTask } from '../api/types';
import type { WriteResult } from '../hooks/useTaskActions';

const PRIMARY_BUTTON =
  'h-[26px] rounded-[5px] bg-accent px-2.5 text-[12px] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45';
const SECONDARY_BUTTON =
  'h-[26px] rounded-[5px] border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink';
const FIELD_LABEL = 'text-[11.5px] font-semibold text-ink-2';
const FIELD_INPUT =
  'mt-1 w-full rounded-[5px] border border-line bg-surface-2 px-2 py-1 text-[13px] outline-none focus:border-accent-border disabled:cursor-not-allowed disabled:text-ink-3';
const QUICK_BUTTON =
  'h-[22px] rounded-[4px] border border-line px-1.5 text-[11px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink';

/** 工期输入非法时的提示。上限来自 lib/format.ts，两边不会漂移。 */
const DURATION_INVALID_HINT = `工期必须是 0 到 ${MAX_DURATION_MINUTES / MINUTES_PER_DAY} 天之间的整数`;

/**
 * 任务详情抽屉（定版原型 B）。**只做字段编辑**：标题、描述、工期。
 * 归档与删除在卡片的「⋯」菜单里（用户的判断：破坏性与状态类操作不该和「改字段」同处一屏）。
 *
 * 面板打开的是当前看板里某张卡片对应的任务，也就是当前看板所在任务的子任务；删除落在卡片菜单上
 * （见 App.tsx 的 deleteTask），所以这里不再有「误删正在看的这一层」这回事，也没有归档态要处理
 * ——已归档的卡片不给编辑入口，归档正在编辑的任务时父组件会把抽屉收掉。
 *
 * 组件内保存着表单的草稿副本，靠父组件的 `key={task.id}` 在换任务时整体重置，
 * 不需要用一个 effect 去同步 props（保存成功后的归一化是显式回写，见 handleSave）。
 */
export function TaskEditorPanel({
  task,
  onClose,
  onSave,
}: {
  task: BoardTask;
  onClose: () => void;
  onSave: (patch: TaskFieldsPatch) => Promise<WriteResult>;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [duration, setDuration] = useState<DurationParts>(() => splitDuration(task.durationMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  // 打开就把焦点收进抽屉：否则焦点留在遮罩后面的「⋯」按钮上，Tab 要先走完整块看板才轮到表单。
  // 这里只保证「Tab 从抽屉内部开始」，不做完整的焦点陷阱——顶栏在遮罩之外仍然可点，
  // 那是抽屉打开时唯一可用的导航（面包屑）。也因此不加 aria-modal。
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

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
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // 把草稿换成服务端归一化后的值：标题两端空格被后端 trim、工期被折成标准单位。不换的话
    // 输入框里留着 "  支付  " 或 "36 小时"，与旁边卡片显示的 "支付" / "1 天 12 小时" 对不上。
    setTitle(result.task.title);
    setDescription(result.task.description);
    setDuration(splitDuration(result.task.durationMinutes));
    setSaved(true);
  }

  /** 抽屉整体是一个 form，所以标题框里按 Enter 与点「保存」走同一条路（描述框里 Enter 仍是换行）。 */
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void handleSave();
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
        ref={panelRef}
        role="dialog"
        aria-label="任务详情"
        tabIndex={-1}
        className="relative flex w-[360px] flex-none flex-col border-l border-line bg-surface shadow-[-8px_0_24px_rgba(29,33,38,0.08)] outline-none"
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

        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
            <label className="block">
              <span className={FIELD_LABEL}>标题</span>
              <input
                value={title}
                maxLength={200}
                onChange={(event) => {
                  markEdited();
                  setTitle(event.target.value);
                }}
                className={FIELD_INPUT}
              />
            </label>
            {/* 提示放在 label 外面：否则它会被算进输入框的无障碍名称里，读屏会念成「标题标题不能为空」。 */}
            {trimmedTitle === '' && (
              <span className="mt-1 block text-[11px] text-danger">标题不能为空</span>
            )}

            <label className="mt-3 block">
              <span className={FIELD_LABEL}>描述</span>
              <textarea
                value={description}
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
            <fieldset className="mt-3">
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
                  className={QUICK_BUTTON}
                >
                  未估工期
                </button>
                <button
                  type="button"
                  onClick={() => {
                    markEdited();
                    setDuration({ days: '', hours: '', minutes: '0' });
                  }}
                  className={QUICK_BUTTON}
                >
                  瞬时
                </button>
                <span className="ml-auto text-[11px] tabular-nums text-ink-3">
                  {durationInput.kind === 'invalid'
                    ? DURATION_INVALID_HINT
                    : durationInput.kind === 'unset'
                      ? '未估工期'
                      : formatDuration(durationInput.value)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-ink-3">1 天 = 480 分钟（8 小时工作制）</p>
            </fieldset>

            {/* 保存与失败都只改这一小块文字，用 aria-live 让读屏也听得到。 */}
            <div aria-live="polite">
              {error !== null && <p className="mt-3 text-[11.5px] text-danger">{error}</p>}
              {saved && <p className="mt-3 text-[11.5px] text-ink-3">已保存</p>}
            </div>
          </div>

          <footer className="flex flex-none gap-1.5 border-t border-line px-3.5 py-3">
            <button type="submit" disabled={!canSave} className={PRIMARY_BUTTON}>
              保存
            </button>
            <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
              取消
            </button>
          </footer>
        </form>
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
