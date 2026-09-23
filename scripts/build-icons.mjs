#!/usr/bin/env node
/**
 * 从 brand/ 下的 SVG 母版生成 apps/web/public/ 下的图标产物。
 *
 * 用法：node scripts/build-icons.mjs
 *
 * 为什么需要这个脚本（而不是每次手工导出）：品牌母版改了之后，favicon.svg、favicon.ico、
 * apple-touch-icon.png、icon-512.png 四份产物必须跟着一起变，漏掉一份就会出现
 * 「标签页图标是新的、桌面快捷方式是旧的」这种没人会发现的不一致。
 *
 * 为什么用无头 Chrome 而不是 ImageMagick：ImageMagick 6 的内置 SVG 渲染器
 * （本机没有 librsvg delegate）会静默忽略 <mask>、并把渐变按自己的方式重算——
 * 实测同一份带 mask 的图标，Chrome 渲出来 center 是透明的，convert 渲出来
 * center 是不透明的、颜色也不对（见 docs/decisions.md D57）。图标正是靠这些
 * 细节成立的东西，所以宁可靠浏览器自己渲染。
 *
 * 产物是**提交进版本库的**：普通构建、CI、用户 clone 之后都不需要装 Chrome，
 * 只有改母版时才需要跑这个脚本。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPngHasContent } from './png-stats.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const brandDir = path.join(repoRoot, 'brand');
const publicDir = path.join(repoRoot, 'apps', 'web', 'public');

/** Chrome 可执行文件：先看 CHROME 环境变量，再按常见名字/路径找。 */
function findChrome() {
  const candidates = [
    process.env.CHROME,
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = candidate.includes('/') ? candidate : execFileSync('which', [candidate], { encoding: 'utf8' }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {
      // which 没找到就试下一个；这里不报错，最后统一给一条清楚的提示。
    }
  }
  throw new Error('找不到 Chrome。设置 CHROME=/path/to/chrome 后重试。');
}

/**
 * 把一份 SVG 渲染成 size×size 的 PNG。
 *
 * background 传 null 表示透明底；传颜色（例如 `#4a5ad9`）表示先铺一层底色——
 * apple-touch-icon 必须不透明，否则 iOS 会把透明像素填成黑色。
 */
function renderPng(chrome, svgPath, size, outPath, background = null) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const bodyBackground = background ?? 'transparent';
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:${bodyBackground};overflow:hidden}
svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailuo-icon-'));
  const htmlPath = path.join(tmpDir, 'icon.html');
  fs.writeFileSync(htmlPath, html);
  try {
    execFileSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        // 设备像素比固定为 1：否则在 HiDPI 机器上会渲出 2 倍尺寸的 PNG，
        // 而 ICO 里记录的尺寸与实际像素不符，Windows 会缩放得很难看。
        '--force-device-scale-factor=1',
        // 没有这一条时截图底色是白的，透明图标会变成白底方块。
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${outPath}`,
        `file://${htmlPath}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  checkPngSize(outPath, size);
  // 尺寸对不代表画对了：白图、全透明图、纯色块的 IHDR 全都完全正常，
  // 只有解码像素才看得出来。这里挡在写进 public/ 之前。
  assertPngHasContent(outPath);
}

/** 校验渲染结果确实是 size×size：Chrome 被窗口最小尺寸限制时不会报错，只会给错尺寸。 */
function checkPngSize(file, size) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`${file} 不是 PNG`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== size || height !== size) {
    throw new Error(`${file} 尺寸是 ${width}×${height}，期望 ${size}×${size}`);
  }
}

/**
 * 把若干 PNG 拼成一个 ICO。
 *
 * ICO 从 Vista 起允许每一帧直接内嵌 PNG，所以这里不需要 BMP 编码器：
 * 6 字节文件头 + 每帧 16 字节目录项 + 各帧的 PNG 原始字节。
 * colorPlanes/bitCount 按惯例写 1/32，Windows 会以 PNG 头里的信息为准。
 */
function writeIco(pngPaths, outPath) {
  const images = pngPaths.map((file) => {
    const buffer = fs.readFileSync(file);
    const size = buffer.readUInt32BE(16);
    return { size, buffer };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = ICO
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, buffer }) => {
    const entry = Buffer.alloc(16);
    // 256 在这个字段里用 0 表示，所以不能直接写 size。
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // 调色板颜色数，PNG 帧固定 0
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buffer.length;
    return entry;
  });

  fs.writeFileSync(outPath, Buffer.concat([header, ...entries, ...images.map((i) => i.buffer)]));
}

const chrome = findChrome();
fs.mkdirSync(publicDir, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailuo-ico-'));
try {
  // favicon.ico / apple-touch-icon 走「有底版」：透明底的单色 M 在深色标签栏上
  // 对比度只有 2.9:1，iOS 又会把透明像素填黑，所以这两处必须带底色。
  const icoPngs = [16, 32, 48].map((size) => {
    const out = path.join(tmpDir, `tile-${size}.png`);
    renderPng(chrome, path.join(brandDir, 'icon-tile.svg'), size, out);
    return out;
  });
  writeIco(icoPngs, path.join(publicDir, 'favicon.ico'));

  // apple-touch-icon 要 180×180 且不透明：这里给圆角方块垫上同一个靛色，
  // 让圆角外的像素也是品牌色，而不是黑色。
  renderPng(
    chrome,
    path.join(brandDir, 'icon-tile.svg'),
    180,
    path.join(publicDir, 'apple-touch-icon.png'),
    '#4a5ad9',
  );

  // 应用图标母版的大图产物：透明底、四个折面。将来 Tauri 的图标集、
  // GitHub 的仓库头像都从这里出，现在先落一份进版本库。
  renderPng(chrome, path.join(brandDir, 'icon.svg'), 512, path.join(publicDir, 'icon-512.png'));

  fs.copyFileSync(path.join(brandDir, 'favicon.svg'), path.join(publicDir, 'favicon.svg'));
  // 界面顶栏的品牌标直接用这份母版（<img src="/icon.svg">）：组件里再抄一遍路径就会
  // 出现两份几何，改母版忘了改组件时没人会发现。原样复制，保持单一来源。
  fs.copyFileSync(path.join(brandDir, 'icon.svg'), path.join(publicDir, 'icon.svg'));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

for (const name of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon.svg', 'icon-512.png']) {
  const file = path.join(publicDir, name);
  console.log(`${name}  ${fs.statSync(file).size} 字节`);
}
