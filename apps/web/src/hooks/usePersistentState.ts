import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { readStored, writeStored } from '../lib/storage';

/**
 * 一个存进 localStorage 的 state，用法与 useState 相同。
 * `isExpected` 用来校验读回来的形状：存储里的内容可能是旧版本写的或手改过的，
 * 形状不对就当没存过，不要让它带着错误类型进入组件。
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  isExpected: (value: unknown) => boolean,
): readonly [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readStored(key, initial, isExpected));

  useEffect(() => {
    writeStored(key, value);
  }, [key, value]);

  return [value, setValue] as const;
}
