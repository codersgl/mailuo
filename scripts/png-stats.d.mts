/**
 * `png-stats.mjs` 的类型声明。
 *
 * 测试（TypeScript）与构建脚本（纯 Node）共用同一份实现，所以要给它配一份
 * 声明文件，否则 `apps/web/test/brandAssets.test.ts` 里那句 import 过不了 tsc。
 */
export interface PngImage {
  width: number;
  height: number;
  /** 3 = 真彩色，4 = 真彩 + alpha。 */
  channels: number;
  pixels: Uint8Array;
}

export function decodePng(source: string | Buffer): PngImage;
export function pixelAt(image: PngImage, x: number, y: number): [number, number, number, number];
export function colorHistogram(image: PngImage): Map<string, number>;
export function assertPngHasContent(file: string): void;
