/**
 * 加载中 / 加载失败两行文案。看板区与文件树都用它：
 * 两处各写一份会把「失败显示后端文案 + 给重试按钮」的规则复制成两份。
 */

export function LoadingNote() {
  return <p className="px-3 py-4 text-[12.5px] text-ink-3">加载中…</p>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="px-3 py-4">
      <p className="text-[12.5px] text-ink-2">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 h-[26px] rounded-[5px] border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink"
      >
        重试
      </button>
    </div>
  );
}
