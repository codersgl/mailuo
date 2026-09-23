import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { colorHistogram, decodePng, pixelAt } from '../../../scripts/png-stats.mjs';

/**
 * 品牌图标产物的守卫。
 *
 * 这几份文件是**提交进版本库的二进制**（`scripts/build-icons.mjs` 生成），
 * 平时没人会打开它们看，所以「生成脚本坏了、产物是白图、ICO 里少了 16px 那帧」
 * 这类问题会一路带到用户的任务栏上才被发现。这里把两件事都核一遍：
 * 二进制结构对不对（尺寸、透明与否、ICO 的帧与偏移），以及**画出来的像素对不对**
 * （颜色与空白）——只看 IHDR 的话，一张纯白图是完全合格的。
 *
 * 另外两条是防漂移用的：public/ 下的 SVG 是 brand/ 母版的**原样复制**，
 * 三份母版里的 M 几何也必须一致，改了其中一处忘了其余几处时会红。
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const publicDir = path.join(repoRoot, 'apps', 'web', 'public');
const brandDir = path.join(repoRoot, 'brand');

const read = (file: string) => fs.readFileSync(file);

/** 品牌色：彩色母版的四个折面，加白色（M 的反色与底版图标里的字母）。 */
const BRAND = {
  indigo: '#4a5ad9ff',
  lightIndigo: '#6f7dffff',
  cyan: '#18aecbff',
  teal: '#0e7f96ff',
  white: '#ffffffff',
};

/** 颜色占比，用于写「至少有 5% 是白的」这类断言。分母是整张图的像素数。 */
function share(image: ReturnType<typeof decodePng>, color: string): number {
  const histogram = colorHistogram(image);
  return (histogram.get(color) ?? 0) / (image.width * image.height);
}

/** PNG 的 IHDR：宽高各 4 字节（偏移 16/20），颜色类型 1 字节（偏移 25）。6 带 alpha，2 不带。 */
function readPngHeader(file: string) {
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

/** 取出 ICO 某一帧的 PNG 字节。 */
function icoFramePng(entry: ReturnType<typeof readIcoEntries>[number]) {
  return entry.buffer.subarray(entry.offset, entry.offset + entry.bytes);
}

/** 从 SVG 里取所有路径的 d 属性。 */
function pathData(file: string): string[] {
  const found: string[] = [];
  for (const match of read(file).toString('utf8').matchAll(/\sd="([^"]+)"/g)) {
    const data = match[1];
    // 正则里有捕获组，理论上不会 undefined；真出现说明文件被改坏了，
    // 这里的报错比后面「三条路径不一致」的断言更能说明问题。
    if (data === undefined) throw new Error(`${file} 里有空的 d 属性`);
    found.push(data);
  }
  return found;
}

describe('品牌图标产物', () => {
  it('favicon.ico 里是 16/32/48 三帧内嵌 PNG，且每帧都画了 M', () => {
    const entries = readIcoEntries(path.join(publicDir, 'favicon.ico'));

    expect(entries.map((entry) => entry.width)).toEqual([16, 32, 48]);
    for (const entry of entries) {
      const payload = icoFramePng(entry);
      // ICO 允许内嵌 BMP，但我们的脚本写的是 PNG：帧头必须是 PNG 签名，
      // 否则 Windows 会按 BMP 解析出一张乱码图。
      expect(payload.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(payload.readUInt32BE(16)).toBe(entry.width);

      // 像素层面的检查：底版图标是靛色块 + 白 M，两色都必须真的存在。
      // 「三帧全换成纯靛色块、M 消失」这种故障只有看像素才发现。
      const frame = decodePng(payload);
      expect(share(frame, BRAND.white), `${entry.width}px 帧里的白色 M`).toBeGreaterThan(0.05);
      expect(share(frame, BRAND.indigo), `${entry.width}px 帧里的靛色底`).toBeGreaterThan(0.3);
    }
  });

  it('apple-touch-icon 是 180×180、不带透明通道、且真的画了白 M', () => {
    const png = readPngHeader(path.join(publicDir, 'apple-touch-icon.png'));

    // iOS 会把透明像素填成黑色，所以这一张必须不透明（colorType 2 而不是 6）。
    expect([png.width, png.height]).toEqual([180, 180]);
    expect(png.colorType).toBe(2);

    const image = decodePng(path.join(publicDir, 'apple-touch-icon.png'));
    expect(share(image, BRAND.white)).toBeGreaterThan(0.05);
    expect(share(image, BRAND.indigo)).toBeGreaterThan(0.5);
  });

  it('应用图标母版大图是 512×512、四角透明、四个折面都在', () => {
    const file = path.join(publicDir, 'icon-512.png');
    const png = readPngHeader(file);

    expect([png.width, png.height]).toEqual([512, 512]);
    // 这个版本的四个折面外全是透明的，浅色底与深色底都直接透出背景。
    expect(png.colorType).toBe(6);

    const image = decodePng(file);
    for (const corner of [
      [2, 2],
      [509, 2],
      [2, 509],
      [509, 509],
    ] as const) {
      expect(pixelAt(image, corner[0], corner[1])[3], `角 ${corner} 的 alpha`).toBe(0);
    }
    // 四个折面各占一块面积：只断言「颜色存在」不够，占比下限能挡住
    // 「只剩一个折面」或「整体被单色覆盖」这类半坏的情况。
    // 实测占比：两条腿各 8.6%，两条斜带各 4.3%（斜带面积本来就是腿的一半），
    // 所以 3% 是留了余量的下限，不是把实测值抄一遍。
    for (const [name, color] of [
      ['左腿', BRAND.indigo],
      ['右腿', BRAND.teal],
      ['左斜带', BRAND.lightIndigo],
      ['右斜带', BRAND.cyan],
    ] as const) {
      expect(share(image, color), `${name}的占比`).toBeGreaterThan(0.03);
    }
  });

  it('public 下的 SVG 与 brand 母版逐字节一致', () => {
    for (const name of ['icon.svg', 'favicon.svg']) {
      expect(read(path.join(publicDir, name)), `${name} 与母版不一致，跑一次 pnpm icons`).toEqual(
        read(path.join(brandDir, name)),
      );
    }
  });

  it('三份母版里的 M 几何是同一组路径', () => {
    // M 的几何在 icon-mono / icon-tile / favicon 里各写了一份（它们底色与是否带
    // <g transform> 各不相同，没法直接共用路径片段）。这条断言就是那份约定的守卫：
    // 改了小尺寸母版的腿宽而没同步另外两份时，会出现「标签页图标是新的、
    // ICO 与 apple-touch-icon 还是旧的」——最难发现的一种不一致。
    const mono = pathData(path.join(brandDir, 'icon-mono.svg'));

    expect(mono).toHaveLength(4);
    expect(pathData(path.join(brandDir, 'icon-tile.svg'))).toEqual(mono);
    expect(pathData(path.join(brandDir, 'favicon.svg'))).toEqual(mono);
  });
});

describe('index.html 的图标声明', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'apps', 'web', 'index.html'), 'utf8');

  it('三种图标都被声明', () => {
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('href="/favicon.svg"');
    expect(html).toContain('href="/apple-touch-icon.png"');
  });

  it('为 favicon.ico 声明的尺寸集合与它的帧完全一致', () => {
    // 声明与产物不符时不会有任何报错：Firefox 会拿 sizes 在候选之间挑选，
    // 把三帧的 ICO 标成只有 32×32，另外两帧就等于白做。
    const declared = /href="\/favicon\.ico"\s+sizes="([^"]+)"/.exec(html)?.[1];
    const frames = readIcoEntries(path.join(publicDir, 'favicon.ico')).map(
      (entry) => `${entry.width}x${entry.width}`,
    );

    expect(declared?.split(/\s+/).sort()).toEqual(frames.sort());
  });

  it('主题色跟随深浅两套令牌', () => {
    // 地址栏配色写错不会报错，只会让移动端浏览器顶栏和页面不是一个颜色，所以钉住两个值。
    expect(html).toContain('content="#f6f7f9" media="(prefers-color-scheme: light)"');
    expect(html).toContain('content="#17191d" media="(prefers-color-scheme: dark)"');
  });
});
