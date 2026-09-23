import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrandMark } from '../src/components/BrandMark';

describe('BrandMark', () => {
  it('引品牌母版，默认 20px', () => {
    const { container } = render(<BrandMark />);
    const img = container.querySelector('img');

    expect(img?.getAttribute('src')).toBe('/icon.svg');
    expect(img?.getAttribute('width')).toBe('20');
    expect(img?.getAttribute('height')).toBe('20');
  });

  it('是纯装饰：alt 为空，读屏不会念出一个没有意义的图形', () => {
    // 产品名就在旁边，这里再报一次名字只会让读屏读出「脉络 脉络」。
    const { container } = render(<BrandMark />);

    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it('尺寸可覆盖', () => {
    const { container } = render(<BrandMark size={32} />);

    expect(container.querySelector('img')?.getAttribute('width')).toBe('32');
  });
});

afterEach(() => {
  cleanup();
});
