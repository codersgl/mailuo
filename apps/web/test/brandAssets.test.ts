import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 品牌图标产物的守卫。
 *
 * 这几份文件是**提交进版本库的二进制**（`scripts/build-icons.mjs` 生成），
 * 平时没人会打开它们看，所以「生成脚本坏了、产物是白图、ICO 里少了 16px 那帧」
 * 这类问题会一路带到用户的任务栏上才被发现。这里把它们按二进制格式核对一遍：
 * 结构对不对、尺寸对不对、透明与否对不对。
 *
 * 另外两条是防漂移用的：public/ 下的 SVG 是 brand/ 母版的**原样复制**，
 * 改了母版忘了跑 `pnpm icons` 时，这里会红。
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const publicDir = path.join(repoRoot, 'apps', 'web', 'public');
const brandDir = path.join(repoRoot, 'brand');

const read = (file: string) => fs.readFileSync(file);

/** PNG 的 IHDR：宽高各 4 字节（偏移 16/20），颜色类型 1 字节（偏移 25）。6 表示带 alpha，2 表示不带。 */
function readPng(file: string) {
  const buffer = read(file);
  expect(buffer.subarray(1, 4).toString('ascii'), `${file} 的 PNG 签名`).toBe('PNG');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer.readUInt8(25),
  };
}

/** ICO 目录：6 字节文件头 + 每帧 16 字节目录项，帧数据从 imageOffset 开始。 */
function readIcoEntries(file: string) {
  const buffer = read(file);
  expect(buffer.readUInt16LE(0), 'ICO reserved').toBe(0);
  expect(buffer.readUInt16LE(2), 'ICO type').toBe(1);
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16;
    return {
      // 256 在这个字段里编码为 0，这里换算回真实尺寸。
      width: buffer.readUInt8(entry) || 256,
      bytes: buffer.readUInt32LE(entry + 8),
      offset: buffer.readUInt32LE(entry + 12),
      buffer,
    };
  });
}

describe('品牌图标产物', () => {
  it('favicon.ico 里是 16/32/48 三帧内嵌 PNG', () => {
    const entries = readIcoEntries(path.join(publicDir, 'favicon.ico'));

    expect(entries.map((entry) => entry.width)).toEqual([16, 32, 48]);
    for (const entry of entries) {
      const payload = entry.buffer.subarray(entry.offset, entry.offset + entry.bytes);
      // ICO 允许内嵌 BMP，但我们的脚本写的是 PNG：帧头必须是 PNG 签名，
      // 否则 Windows 会按 BMP 解析出一张乱码图。
      expect(payload.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(payload.readUInt32BE(16)).toBe(entry.width);
    }
  });

  it('apple-touch-icon 是 180×180 且不带透明通道', () => {
    // iOS 会把透明像素填成黑色，所以这一张必须不透明（colorType 2 而不是 6）。
    const png = readPng(path.join(publicDir, 'apple-touch-icon.png'));

    expect([png.width, png.height]).toEqual([180, 180]);
    expect(png.colorType).toBe(2);
  });

  it('应用图标母版大图是 512×512 且带透明通道', () => {
    const png = readPng(path.join(publicDir, 'icon-512.png'));

    expect([png.width, png.height]).toEqual([512, 512]);
    // 这个版本的四个折面外全是透明的，浅色底与深色底都直接透出背景。
    expect(png.colorType).toBe(6);
  });

  it('public 下的 SVG 与 brand 母版逐字节一致', () => {
    for (const name of ['icon.svg', 'favicon.svg']) {
      expect(read(path.join(publicDir, name)), `${name} 与母版不一致，跑一次 pnpm icons`).toEqual(
        read(path.join(brandDir, name)),
      );
    }
  });
});

describe('index.html 的图标声明', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'apps', 'web', 'index.html'), 'utf8');

  it('三种图标都被声明', () => {
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('href="/apple-touch-icon.png"');
  });

  it('主题色跟随深浅两套令牌', () => {
    // 地址栏配色写错不会报错，只会让移动端浏览器顶栏和页面不是一个颜色，所以钉住两个值。
    expect(html).toContain('content="#f6f7f9" media="(prefers-color-scheme: light)"');
    expect(html).toContain('content="#17191d" media="(prefers-color-scheme: dark)"');
  });
});
