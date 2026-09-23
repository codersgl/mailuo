import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { WriteResult } from '../hooks/useTaskActions';

/**
 * 列底部的新建任务行：只有标题一个字段。
 *
 * 描述与工期不在这里填：`POST /api/tasks` 只接受标题（见 docs/spec.md），建完在右侧面板里改。
 * 一个字段的表单也做成 form，这样 Enter 提交是浏览器原生行为，不用自己监听按键。
 */
export function NewTaskForm({
  columnName,
  onSubmit,
  onCancel,
}: {
  columnName: string;
  onSubmit: (title: string) => Promise<WriteResult>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const trimmed = title.trim();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (trimmed === '' || saving) return;

    setSaving(true);
    setError(null);
    const result = await onSubmit(trimmed);
    // 成功时父组件会把这一行收起（组件卸载），不必再写状态；只有失败才需要留在原地报错。
    if (!result.ok) {
      setError(result.message);
      setSaving(false);
    }
  }

  /** Esc 取消。阻止冒泡：否则会顺带把可能开着的任务面板一起关掉。 */
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onCancel();
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      className="rounded-[5px] border border-accent-border bg-surface p-[9px]"
    >
      <input
        // 打开就聚焦：用户点「+」之后一定是要打字。
        autoFocus
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          setError(null);
        }}
        aria-label={`在「${columnName}」新建任务`}
        placeholder="任务标题"
        maxLength={200}
        className="w-full rounded-[5px] border border-line bg-surface-2 px-2 py-1 text-[13px] outline-none focus:border-accent-border"
      />

      {error !== null && <p className="mt-1 text-[11px] text-danger">{error}</p>}

      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="submit"
          disabled={saving || trimmed === ''}
          className="h-[24px] rounded-[5px] bg-accent px-2 text-[12px] text-on-fill hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          添加
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-[24px] rounded-[5px] border border-line bg-surface px-2 text-[12px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink"
        >
          取消
        </button>
        <span className="ml-auto whitespace-nowrap text-[10.5px] text-ink-3">Enter 提交 · Esc 取消</span>
      </div>
    </form>
  );
}
