/**
 * 发布物清单的用例：`npm pack` 出来的 tarball 必须能自己跑起来。
 *
 * 为什么要盯着 `package.json`：这些字段的错法在仓库里全部看不见。`private: true` 只让
 * `npm publish` 在最后一步失败；`files` 漏一个目录，本地一切正常，用户装完却少文件；服务端产物
 * 按哪种模块格式解析，取决于**装完之后**包根有没有 `type`——仓库里因为存在
 * `apps/api/package.json`（它不入 tarball），这个字段写不写都跑得通。
 *
 * 实测（Node 22.23，见 docs/decisions.md D66）：去掉 `type` 后，装了包的机器靠 Node 的语法探测
 * 仍能起服务；但探测是 22.7 才默认打开的行为，加 `NODE_OPTIONS=--no-experimental-detect-module`
 * 复现的是老 22.x 用户会遇到的失败——`启动失败：Cannot require() ES Module ... in a cycle`。
 *
 * 这里只做不需要构建、不联网的清单核对；真装一遍 tarball 的烟测是发布前手工跑的，见 D66。
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

/** 服务端进程运行时要读的包内路径；`files` 少一个，用户那边的安装就是残缺的。 */
const REQUIRED_FILES = [
  'bin/mailuo.mjs',
  'apps/api/dist/',
  'apps/api/migrations/',
  'apps/web/dist/',
  'LICENSE',
  'README.md',
];

test('package.json 可以被发布：去掉 private，并显式声明 ESM', () => {
  assert.notEqual(packageJson.private, true, 'private: true 会让 npm publish 直接失败');
  assert.equal(
    packageJson.type,
    'module',
    'apps/api/package.json 不入 tarball，包根必须是 ESM，否则服务端产物要靠 Node 的语法探测才能加载',
  );
});

test('bin 指向一个存在的文件', () => {
  assert.equal(packageJson.bin?.mailuo, 'bin/mailuo.mjs');
  assert.ok(existsSync(path.join(packageRoot, packageJson.bin.mailuo)));
});

test('files 覆盖服务端运行时要读的路径', () => {
  for (const entry of REQUIRED_FILES) {
    assert.ok(packageJson.files?.includes(entry), `files 缺少 ${entry}`);
  }
});

test('服务端产物的运行时依赖都声明在包根的 dependencies 里', () => {
  const distDir = path.join(packageRoot, 'apps', 'api', 'dist');
  // 没构建过就没有产物可查。构建产物不入版本库，这一步跳过而不是失败。
  if (!existsSync(distDir)) {
    return;
  }

  // 从 `import x from 'y'`、`import 'y'`、`await import('y')` 三种写法里取模块名。
  const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
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
