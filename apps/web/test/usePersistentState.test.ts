import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePersistentState } from '../src/hooks/usePersistentState';

/** 树面板的展开状态与「显示已归档」开关都走这个 hook（见 docs/spec.md：只存前端，不落库）。 */

const KEY = 'kanban.test.state';
const isStringArray = (value: unknown): boolean => Array.isArray(value);

afterEach(() => {
  window.localStorage.clear();
});

describe('usePersistentState', () => {
  it('没存过时用初始值，并存下初始值', () => {
    const { result } = renderHook(() => usePersistentState(KEY, ['默认'], isStringArray));

    expect(result.current[0]).toEqual(['默认']);
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(['默认']));
  });

  it('从 localStorage 读回上次的值', () => {
    window.localStorage.setItem(KEY, JSON.stringify(['a']));

    const { result } = renderHook(() => usePersistentState(KEY, [], isStringArray));

    expect(result.current[0]).toEqual(['a']);
  });

  it('存的值形状不对时回到初始值', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ a: 1 }));

    const { result } = renderHook(() => usePersistentState(KEY, [], isStringArray));

    expect(result.current[0]).toEqual([]);
  });

  it('改值会写回 localStorage', () => {
    const { result } = renderHook(() => usePersistentState(KEY, [] as string[], isStringArray));

    act(() => result.current[1](['a', 'b']));

    expect(result.current[0]).toEqual(['a', 'b']);
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(['a', 'b']));
  });

  it('布尔开关也能存（「显示已归档」用它）', () => {
    const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
    const { result } = renderHook(() => usePersistentState(KEY, false, isBoolean));

    act(() => result.current[1](true));

    expect(window.localStorage.getItem(KEY)).toBe('true');
  });
});
