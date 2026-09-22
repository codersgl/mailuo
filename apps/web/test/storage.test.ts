import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStored, writeStored } from '../src/lib/storage';

/** localStorage 本身可能不可用（隐私模式、被禁用），两个方向的读写都不能把异常抛给组件。 */

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('readStored', () => {
  it('没存过时用 fallback', () => {
    expect(readStored('kanban.missing', ['默认'], Array.isArray)).toEqual(['默认']);
  });

  it('存过就解出来', () => {
    window.localStorage.setItem('kanban.k', JSON.stringify(['a']));

    expect(readStored('kanban.k', [], Array.isArray)).toEqual(['a']);
  });

  it('内容不是 JSON 时用 fallback', () => {
    window.localStorage.setItem('kanban.k', '{坏掉的');

    expect(readStored('kanban.k', [], Array.isArray)).toEqual([]);
  });

  it('形状不符时用 fallback，而不是把错的类型放进组件', () => {
    window.localStorage.setItem('kanban.k', JSON.stringify({ a: 1 }));

    expect(readStored('kanban.k', [], Array.isArray)).toEqual([]);
  });

  it('localStorage 抛异常时用 fallback', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(readStored('kanban.k', false, (value) => typeof value === 'boolean')).toBe(false);
  });
});

describe('writeStored', () => {
  it('写进去的能被 readStored 读回来', () => {
    writeStored('kanban.k', ['a', 'b']);

    expect(readStored('kanban.k', [], Array.isArray)).toEqual(['a', 'b']);
  });

  it('localStorage 抛异常时不往外传', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    expect(() => writeStored('kanban.k', ['a'])).not.toThrow();
  });
});
