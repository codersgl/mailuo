import { vi } from 'vitest';

/**
 * jsdom 不实现 `window.matchMedia`（见 docs/decisions.md D43），所以凡是会读系统配色的用例
 * 都得自己装一个。返回的控制器能做两件事：改系统偏好，以及看现在挂了几个监听器
 * （监听器数量是「还在不在跟随系统」最直接的证据）。
 */
export function stubMatchMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<(event: { matches: boolean }) => void>();

  const query = {
    media: '(prefers-color-scheme: dark)',
    get matches() {
      return dark;
    },
    addEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: (event: { matches: boolean }) => void) {
      listeners.delete(listener);
    },
  };

  vi.stubGlobal('matchMedia', (media: string) => {
    // 代码里只该问这一个查询。别的查询一律当错误，免得测试悄悄放过一个拼错的字符串。
    if (media !== '(prefers-color-scheme: dark)') throw new Error(`没预料到的 media query: ${media}`);
    return query;
  });

  return {
    /** 模拟用户在系统设置里切换深浅。 */
    setDark(next: boolean) {
      dark = next;
      for (const listener of listeners) listener({ matches: next });
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}
