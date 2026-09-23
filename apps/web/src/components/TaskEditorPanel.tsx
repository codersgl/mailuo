import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { buildCandidateGroups, readDependencyEditing, sameDependencySet } from '../domain/layerDeps';
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
import type { BoardTask, ColumnRecord, LayerSchedule } from '../api/types';
import type { AsyncState } from '../hooks/useAsync';
import type { WriteResult } from '../hooks/useTaskActions';
import { DependencySection } from './DependencySection';

const PRIMARY_BUTTON =
  'h-[26px] rounded-[5px] bg-accent px-2.5 text-[12px] text-on-fill hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45';
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
 * 任务详情抽屉（定版原型 B）。做字段编辑：标题、描述、工期，以及前置任务。
 * 归档与删除在卡片的「⋯」菜单里（用户的判断：破坏性与状态类操作不该和「改字段」同处一屏）。
 *
 * 面板打开的是当前看板里某张卡片对应的任务，也就是当前看板所在任务的子任务；删除落在卡片菜单上
 * （见 App.tsx 的 deleteTask），所以这里不再有「误删正在看的这一层」这回事，也没有归档态要处理
 * ——已归档的卡片不给编辑入口，归档正在编辑的任务时父组件会把抽屉收掉。
 *
 * 组件内保存着表单的草稿副本，靠父组件的 `key={task.id}` 在换任务时整体重置，
 * 不需要用一个 effect 去同步 props（保存成功后的归一化是显式回写，见 handleSave）。
 *
 * 依赖（第 14 步）与字段共用底部的「保存」，但它们是两次写：依赖只有变了才发 PUT；
 * 字段那次成功、依赖那次失败时，错误文案必须说清是哪一半（见 handleSave）。
 */
/** 抽屉里「前置任务」区块要用到的东西。字段编辑与依赖编辑共用底部的「保存」。 */
export interface DependencyEditor {
  /**
   * 整层依赖图（`GET /api/board[/:parentId]/cpm`）。还没到位时区块只显示状态，
   * 而且**不会**提交依赖：一份没读到服务端前置的草稿照发出去，等于把已有依赖清空。
   */
  schedule: AsyncState<LayerSchedule>;
  onRetry: () => void;
  /** 这一层的列，只用来查列名；候选任务本身来自依赖图的节点。 */
  columns: readonly ColumnRecord[];
  /** 只在依赖集合真的变了（或要清理已归档的前置）时才被调用。 */
  onSave: (predecessorIds: string[]) => Promise<WriteResult>;
}

export function TaskEditorPanel({
  task,
  onClose,
  onSave,
  dependency,
}: {
  task: BoardTask;
  onClose: () => void;
  onSave: (patch: TaskFieldsPatch) => Promise<WriteResult>;
  dependency: DependencyEditor;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [duration, setDuration] = useState<DurationParts>(() => splitDuration(task.durationMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  const schedule = dependency.schedule;
  /**
   * 依赖的集合口径（谁是当前前置、谁不能选）。`null` 表示图还没到位，此时依赖区块只显示状态。
   * 用 useMemo：图读回来之后它才可能变，输入标题引起的每轮重渲染不必重算可达集合。
   */
  const editingState = useMemo(
    () =>
      schedule.status === 'ready'
        ? readDependencyEditing(task.id, schedule.data.edges, schedule.data.nodes)
        : null,
    [schedule, task.id],
  );
  /**
   * 依赖草稿。`null` 表示「跟着服务端走」，用户第一次勾选才产生一份草稿。
   * 候选列表只在图到位后才画得出来，所以不存在「拿空草稿起步」的时机。
   */
  const [draftDeps, setDraftDeps] = useState<string[] | null>(null);
  const selectedDeps = draftDeps ?? editingState?.selectedIds ?? [];

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

  /** 勾选或取消一项前置。草稿第一次改动时从服务端的前置集合起步。 */
  function toggleDependency(taskId: string, selected: boolean) {
    markEdited();
    setDraftDeps((current) => {
      const base = current ?? editingState?.selectedIds ?? [];
      return selected ? [...base, taskId] : base.filter((id) => id !== taskId);
    });
  }

  /**
   * 草稿里**能提交**的那些。
   *
   * 草稿建立之后图还会变：别的入口把某个前置归档了、或者关系变动让某一项变成环上的一环。
   * 这两种 id 后端都是整份拒绝（400 / 409），把它们留在提交里会让这个任务的保存**永远失败**，
   * 而界面上那一行是「已勾选 + 点不动」——用户在抽屉里没法把它去掉（审阅抓到的阻断项）。
   * 所以按禁用原因剔掉：归档那条正好落进「保存时解除失效依赖」的既有语义。
   */
  const savableDeps =
    editingState === null
      ? selectedDeps
      : selectedDeps.filter((id) => !editingState.blockedReasonById.has(id));

  /**
   * 这次保存要不要连依赖一起提交。
   *
   * 两个来源都算「变了」：可提交的草稿与服务端的前置集合不同；以及存在已归档的前置——它们不能
   * 写回服务端（PUT 会整份拒绝），草稿里本就不含它们，于是这次保存顺带把失效的那条依赖解除。
   */
  const depsNeedSave =
    editingState !== null &&
    (editingState.archivedPredecessorIds.length > 0 ||
      !sameDependencySet(savableDeps, editingState.selectedIds));

  /** 候选列表。图没到位（editingState 为 null）时是空的，区块那时也不画。 */
  const candidateGroups =
    schedule.status === 'ready' && editingState !== null
      ? buildCandidateGroups(
          schedule.data.nodes,
          dependency.columns,
          task.id,
          editingState.blockedReasonById,
          savableDeps,
        )
      : [];

  /**
   * 第二次写：依赖。返回错误文案，null 表示成功或本来不需要写。
   * 字段那一次已经落库了，所以这里失败不能只说「保存失败」——用户会以为什么都没存上、
   * 再点一次，而实际上标题已经改掉了。依赖草稿特意留着，改完可以直接重试。
   */
  async function saveDependencies(): Promise<string | null> {
    if (!depsNeedSave) return null;
    const result = await dependency.onSave([...savableDeps]);
    return result.ok ? null : `标题、描述、工期已保存；依赖未保存：${result.message}`;
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
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      return;
    }
    // 把草稿换成服务端归一化后的值：标题两端空格被后端 trim、工期被折成标准单位。不换的话
    // 输入框里留着 "  支付  " 或 "36 小时"，与旁边卡片显示的 "支付" / "1 天 12 小时" 对不上。
    setTitle(result.task.title);
    setDescription(result.task.description);
    setDuration(splitDuration(result.task.durationMinutes));

    // busy 一直保持到两次写都结束：中途放开会让用户改到一份已经发出去的草稿，
    // 界面显示成已改、实际没提交（见 DependencySection 的 busy 说明）。
    const depsFailure = await saveDependencies();
    setBusy(false);
    if (depsFailure !== null) {
      setError(depsFailure);
      return;
    }
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
        className="absolute inset-0 bg-scrim"
      />

      <aside
        ref={panelRef}
        role="dialog"
        aria-label="任务详情"
        tabIndex={-1}
        className="relative flex w-[360px] flex-none flex-col border-l border-line bg-surface shadow-panel outline-none"
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

            {/*
              依赖区块。加载中与失败只影响这一块：上面的字段照样能改、能保存，依赖那一次写会被跳过
              （depsNeedSave 在 editingState 为 null 时恒为 false），不会拿一份没读到的草稿去覆盖服务端。
            */}
            <div className="mt-3">
              {schedule.status === 'loading' && (
                <p className="text-[11.5px] text-ink-3">前置任务：加载中…</p>
              )}
              {schedule.status === 'failed' && (
                <p className="text-[11.5px] text-danger">
                  前置任务加载失败：{schedule.message}
                  <button type="button" onClick={dependency.onRetry} className="ml-1.5 underline">
                    重试
                  </button>
                </p>
              )}
              {editingState !== null && (
                <DependencySection
                  groups={candidateGroups}
                  selectedCount={savableDeps.length}
                  archivedPredecessorCount={editingState.archivedPredecessorIds.length}
                  busy={busy}
                  onToggle={toggleDependency}
                />
              )}
            </div>

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
