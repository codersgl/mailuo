/**
 * 发布物清单的用例：`npm pack` 出来的 tarball 必须能自己跑起来。
 *
 * 为什么要盯着 `package.json`：这些字段的错法在仓库里全部看不见。`private: true` 只让
 * `npm publish` 在最后一步失败；`files` 漏一个目录，本地一切正常，用户装完却少文件；服务端产物
 * 按哪种模块格式解析，取决于**装完之后**包根有没有 `type`——仓库里因为存在
 * `apps/api/package.json`（它不入 tarball），这个字段写不写都跑得通。
 *
 * 实测（Node 22.23，见 docs/decisions.md D67）：去掉 `type` 后，装了包的机器靠 Node 的语法探测
 * 仍能起服务；但探测是 22.7 才默认打开的行为，加 `NODE_OPTIONS=--no-experimental-detect-module`
 * 复现的是老 22.x 用户会遇到的失败——`启动失败：Cannot require() ES Module ... in a cycle`。
 *
 * 这里只做不需要构建、不联网的清单核对；真装一遍 tarball 的烟测是发布前手工跑的，见 D67。
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

/**
 * 服务端进程运行时要读的包内路径；`files` 少一个，用户那边的安装就是残缺的。
 *
 * 分成两半是因为「清单里写了」与「仓库里真有」是两件事：`npm pack` 对白名单里**不存在**的路径
 * 是静默跳过、仍然成功，所以只核对字符串，改名的目录能一路绿到用户机器上。而 `files` 里的两个
 * 构建产物目录不入版本库（`.gitignore`），干净 checkout 上本来就没有——对它们强制 `existsSync`
 * 会让 `pnpm install && pnpm test` 变红，所以改为「产物在的时候，查它的入口文件」。
 */
const TRACKED_FILES = ['bin/mailuo.mjs', 'apps/api/migrations/', 'LICENSE', 'README.md'];

const BUILT_ARTIFACTS = [
  { entry: 'apps/api/dist/', probe: 'apps/api/dist/index.js', why: 'bin/mailuo.mjs 加载的服务端入口' },
  { entry: 'apps/web/dist/', probe: 'apps/web/dist/index.html', why: '服务端据此判定要不要托管页面' },
];

test('package.json 可以被发布：去掉 private，并显式声明 ESM', () => {
  // 不写成 `private !== true`：npm 判的是真假值，`"private": "true"` 这种字符串同样会让 publish
  // 在最后一步失败，而它不等于 `true`。
  assert.ok(!packageJson.private, 'private 为真会让 npm publish 直接失败');
  assert.equal(
    packageJson.type,
    'module',
    'apps/api/package.json 不入 tarball，包根必须是 ESM，否则服务端产物要靠 Node 的语法探测才能加载',
  );
  // 这两项没有别的地方盯着：漏了不影响任何行为，只让发布出去的卡片在源上没法被检索到。
  assert.ok(
    typeof packageJson.description === 'string' && packageJson.description.trim() !== '',
    'description 不能为空，源上的卡片就靠它说明这个包是做什么的',
  );
  assert.ok(
    Array.isArray(packageJson.keywords) && packageJson.keywords.length > 0,
    'keywords 不能为空数组，否则在源上搜不到',
  );
  // `repository` 不只是个链接：据 D66 的取舍 4 与社区报告（没有官方文档可引），npm 页面靠它把
  // README 里的相对链接与图片指回仓库，没有它，顶部的 `brand/icon.svg` 与 `docs/images/*.webp`
  // 截图会裂。
  //
  // 只断言「指向本仓库」，不锁前缀：npm 接受 `git+https://….git`、裸 `https://…`、
  // `owner/repo` 简写、`github:owner/repo` 等多种等价写法（实测 `npm pack` 打出的 tarball 里
  // 原样保留、发布路径上由 @npmcli/package-json 归一化，见 D68）。锁前缀会在 npm 认可的写法上误报。
  const repositoryUrl =
    typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url;
  assert.match(
    repositoryUrl ?? '',
    /(^|[/:])codersgl\/mailuo(\.git)?$/,
    'repository 要指向本仓库（codersgl/mailuo），否则 npm 页面上的链接与图片会指错地方',
  );
  // 发布目标写进包里，是为了挡住「本机 npm 默认源是只读镜像」这个坑：`npm publish` 不带
  // `--registry` 时会打到镜像上，报错与「没登录」长得一样（见 D68）。
  assert.equal(
    packageJson.publishConfig?.registry,
    'https://registry.npmjs.org',
    'publishConfig.registry 要钉在官方源，否则本机的镜像默认值会让 npm publish 打错地方',
  );
  // scoped 包的默认访问级别是 restricted：不写 public，发布出去的包只有自己（和授权的人）装得到，
  // 而 npm 只在发布时提示一句「需要 --access public」。这是 D69 改用 `@codersgl/mailuo` 之后
  // 新出现的一条失败模式，所以跟着包名一起钉住。
  if (String(packageJson.name).startsWith('@')) {
    assert.equal(
      packageJson.publishConfig?.access,
      'public',
      'scoped 包默认 restricted，publishConfig.access 要写 public，否则别人装不到这个包',
    );
  }
});

test('bin 指向一个存在的文件', () => {
  assert.equal(packageJson.bin?.mailuo, 'bin/mailuo.mjs');
  assert.ok(existsSync(path.join(packageRoot, packageJson.bin.mailuo)));
});

test('files 覆盖服务端运行时要读的路径，且仓库里的那些路径真的存在', () => {
  for (const entry of [...TRACKED_FILES, ...BUILT_ARTIFACTS.map((artifact) => artifact.entry)]) {
    assert.ok(packageJson.files?.includes(entry), `files 缺少 ${entry}`);
  }
  for (const entry of TRACKED_FILES) {
    assert.ok(existsSync(path.join(packageRoot, entry)), `files 里的 ${entry} 在磁盘上不存在，npm pack 会静默跳过它`);
  }
  // 反向：白名单是发布内容的唯一闸门，混进本机文件就会被 `npm pack` 照单收进 tarball。仓根的
  // `.env` 与 `data/kanban.db` 是真实存在的例子，只有这条反向断言盯着它们。
  const leaked = packageJson.files.filter((entry) => /^(\.env|data\/|node_modules\/)/.test(entry));
  assert.deepEqual(leaked, [], `files 里混进了本机文件：${leaked.join('、')}`);
});

test('构建出的产物落在清单覆盖的路径下', () => {
  for (const { probe, why } of BUILT_ARTIFACTS) {
    // 没构建过就没有产物可查。这一步跳过而不是失败，与下面那条依赖用例同一个理由。
    if (!existsSync(path.dirname(path.join(packageRoot, probe)))) {
      continue;
    }
    assert.ok(existsSync(path.join(packageRoot, probe)), `构建产物缺 ${probe}（${why}），发布出去就是残缺的`);
  }
});

test('服务端产物的运行时依赖都声明在包根的 dependencies 里', () => {
  const distDir = path.join(packageRoot, 'apps', 'api', 'dist');
  // 没构建过就没有产物可查。构建产物不入版本库，这一步跳过而不是失败。
  if (!existsSync(distDir)) {
    return;
  }

  // 从 `import x from 'y'`、`export … from 'y'`、`import 'y'`、`await import('y')` 与 `require('y')`
  // 取模块名。`require` 现在一个都匹配不到（产物全是 ESM），留着是为了将来混进 CJS 产物时不会
  // 静默漏过；模板字面量形式的动态 import 取不到静态模块名，不在这里处理。
  const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  const missing = new Set();

  for (const file of listJsFiles(distDir)) {
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(specifierPattern)) {
      // 相对路径与 node: 内置模块不需要声明。
      if (specifier.startsWith('.') || specifier.startsWith('node:')) {
        continue;
      }
      // 取包名：scoped 包是前两段（@scope/name），其余取第一段（name 或 name/sub）。
      const segments = specifier.split('/');
      const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
      if (packageJson.dependencies?.[name] === undefined) {
        missing.add(`${name}（${path.relative(packageRoot, file)}）`);
      }
    }
  }

  assert.deepEqual(
    [...missing],
    [],
    'bin/mailuo.mjs 加载的是包根的 node_modules，这些依赖不声明在根 package.json 里，用户装完 import 会失败',
  );
});

/** 递归列出目录下的 .js 文件（跳过 sourcemap）。 */
function listJsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listJsFiles(full);
    }
    return entry.name.endsWith('.js') ? [full] : [];
  });
}
