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

/**
 * 删掉一个偏好，让它回到「没存过」。
 *
 * 和写 null 的区别：主题的「没存过」是有含义的状态（跟随系统），
 * 存一个字面量 null 会让 localStorage 里留一条 `"null"`，以后排查时看不出这是「清空」还是「写坏了」。
 */
export function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 有意忽略：同 writeStored。
  }
}
