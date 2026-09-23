/**
 * 极简 PNG 解码与检查工具。
 *
 * 为什么需要它：图标产物是没人会打开的二进制，而「生成脚本坏了、渲出一张白图或
 * 全透明图」这类故障从 IHDR 里看不出来——宽高、色深、颜色类型全都正常。
 * `scripts/build-icons.mjs` 用它拒绝写出空白图，`apps/web/test/brandAssets.test.ts`
 * 用它核对产物里真的有那个 M。
 *
 * 只支持 8 位真彩色（colorType 2）与真彩 + alpha（colorType 6），也就是本仓库
 * 图标产物的两种形态；不支持的 PNG 会直接报错，而不是静默返回错数据。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

/** colorType → 每像素通道数。索引色与灰阶不支持：解码出来会当成 RGB 用，那是错的。 */
const CHANNELS_BY_COLOR_TYPE = { 2: 3, 6: 4 };

/**
 * 解码一张 PNG。
 *
 * @param {string | Buffer} source 文件路径或 PNG 字节（ICO 里内嵌的帧用后者）。
 * @returns {{ width: number, height: number, channels: number, pixels: Uint8Array }}
 */
export function decodePng(source) {
  const buffer = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  if (buffer.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new Error('不是 PNG');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer.readUInt8(24);
  const colorType = buffer.readUInt8(25);
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (bitDepth !== 8 || channels === undefined) {
    throw new Error(`只支持 8 位深的 colorType 2/6，实际是 bitDepth=${bitDepth} colorType=${colorType}`);
  }

  // 图像数据可能被切成多个 IDAT 块，按出现顺序拼起来才是一整个 zlib 流。
  const idat = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  // 每行开头有一个滤波类型字节，后面是 stride 字节的滤波后数据。逐行反滤波，
  // 因为下一行的还原依赖上一行已经还原的结果，必须顺序做。
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[cursor];
      cursor += 1;
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[prev + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prev + x - channels] : 0;
      pixels[row + x] = (value + unfilter(filter, left, up, upLeft)) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** PNG 的 5 种行滤波（规格 9.2）。返回要加回原值的预测值。 */
function unfilter(filter, left, up, upLeft) {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      // Paeth：取左、上、左上三者中最接近 (left + up - upLeft) 的那个。
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      if (toLeft <= toUp && toLeft <= toUpLeft) return left;
      return toUp <= toUpLeft ? up : upLeft;
    }
    default:
      throw new Error(`未知的行滤波类型 ${filter}`);
  }
}

/** 取某个像素的 [r, g, b, a]。RGB 图（无 alpha 通道）一律按不透明处理。 */
export function pixelAt(image, x, y) {
  const index = (y * image.width + x) * image.channels;
  return [
    image.pixels[index],
    image.pixels[index + 1],
    image.pixels[index + 2],
    image.channels === 4 ? image.pixels[index + 3] : 255,
  ];
}

/** 颜色直方图，键是 `#rrggbbaa`。 */
export function colorHistogram(image) {
  const histogram = new Map();
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const key = `#${pixelAt(image, x, y)
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('')}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
  }
  return histogram;
}

/**
 * 断言这张图「有内容」：不是纯色，也不是整张透明。
 *
 * 判据是「最常见颜色之外还有多少像素」——白图、全透明图、纯色块都会在这里被拒。
 * 阈值取 3%：16px 的图标一共 256 个像素，其中 M 形通常占 20% 以上，留足余量。
 */
export function assertPngHasContent(file) {
  const image = decodePng(file);
  const histogram = colorHistogram(image);
  const total = image.width * image.height;
  const dominant = Math.max(...histogram.values());
  const others = (total - dominant) / total;
  if (histogram.size < 2 || others < 0.03) {
    throw new Error(
      `${file} 看起来是一张空白图：${histogram.size} 种颜色，最常见颜色占 ${(dominant / total) * 100}%`,
    );
  }
}
