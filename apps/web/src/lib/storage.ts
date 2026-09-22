/**
 * localStorage 的读写包装。两处失败都要吞掉而不是抛给调用方：
 * 隐私模式或存储被禁用时 `localStorage` 本身可能抛异常，而「展开状态没存上」
 * 不该让整个页面白屏——这类偏好丢了只是回到默认值。
 */

/** 读一个 JSON 值。缺失、解析失败、形状不对（isExpected 返回 false）都回落到 fallback。 */
export function readStored<T>(key: string, fallback: T, isExpected: (value: unknown) => boolean): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isExpected(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 写一个 JSON 值。写不进去（配额满、被禁用）时静默放弃。 */
export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 有意忽略：偏好存不上不影响本次会话的使用。
  }
}
