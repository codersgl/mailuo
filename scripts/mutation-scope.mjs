#!/usr/bin/env node
/**
 * 只对「本次 diff 改到的行」跑变异测试（差分门禁）。
 *
 * 用法（在仓库根执行）：
 *   node scripts/mutation-scope.mjs --scope api                 # 只打印范围与命令，不执行
 *   node scripts/mutation-scope.mjs --scope api --run           # 真的跑
 *   node scripts/mutation-scope.mjs --scope web --base origin/main --run
 *   node scripts/mutation-scope.mjs --scope bin --run           # 会先 pnpm build，并去掉 NODE_USE_ENV_PROXY
 *
 * 为什么需要这个脚本：Stryker 10 的配置 schema 里没有「只变异改动文件」的开关（没有 since），
 * 而本仓库三条配置都走命令运行器——Stryker 在这种模式下做不了任何测试选择，只能对每个变异体跑
 * 完整套件（api 597 个点 17–23 分钟、web 1087 个点约 40 分钟、bin 491 个点 44 分钟起）。
 * 差分把变异点数量压到与改动行数成正比，PR 上才放得下。
 *
 * 口径：只取新增/修改行。删除行在新文件里没有行号，无法变异，所以不产生范围。
 * 代价必须知道：差分看不到「改了 A 文件、让远处 B 文件的测试失效」这类问题，它是快速反馈，
 * 不替代定期全量——与 cargo-mutants `--in-diff` 的官方警告是同一件事。
 *
 * 一条贯穿全篇的原则：**拿不准就拒绝执行，不要静默跳过**。这个脚本的产物是一个「绿」，
 * 而漏检和通过长得一模一样；所以路径穿越、含逗号的路径、超过上限的改动都是一句话报错加非零退出，
 * 而不是悄悄少跑几个变异点。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * 改动行数超过上限就拒绝执行，改走全量或显式 `--max-lines`。
 *
 * 上限是「改动行数」不是「变异点数」，两者同量级但不是一回事：同一行改动产出几个变异点只看那行 AST，
 * 可以是 0（例如纯数字字面量——StrykerJS 没有 NumericLiteral 变异器），也可以是 9（实测
 * `clock.ts` 第 40 行那种三个运算符叠一行的写法）。用它当护栏够用，不必精确。
 */
export const DEFAULT_MAX_CHANGED_LINES = 200;

/** 每个 scope 对应一份 stryker 配置，以及「哪些文件在范围内」的判据。 */
export const SCOPES = {
  api: {
    label: 'apps/api/src/domain/** + apps/api/src/server.ts',
    config: null, // null 表示用缺省的 stryker.config.json
    matches: (file) => /^apps\/api\/src\/domain\/.*\.ts$/.test(file) || file === 'apps/api/src/server.ts',
  },
  web: {
    label: 'apps/web/src/{domain,lib}/**',
    config: 'stryker.web.config.json',
    matches: (file) => /^apps\/web\/src\/(domain|lib)\/.*\.tsx?$/.test(file),
  },
  bin: {
    label: 'bin/mailuo.mjs',
    config: 'stryker.bin.config.json',
    matches: (file) => file === 'bin/mailuo.mjs',
    // bin 的用例是进程级的、且绑固定端口，配置里并发写死为 1，所以每个变异体都要 5.3 秒，
    // 30 行大约 2.5 分钟。这是三个 scope 里唯一无法靠并发摊薄的一个，上限必须更紧。
    maxChangedLines: 30,
    // 进程级用例要读构建产物；导出的 NODE_USE_ENV_PROXY 会让「stderr 为空」那条断言失败。
    buildFirst: true,
    dropEnv: ['NODE_USE_ENV_PROXY'],
  },
};

/**
 * 不能出现在 `--mutate` 取值里的字符。
 *
 * Stryker CLI 用 `createSplitter(',')` 解析 `--mutate`，路径里的逗号会把一个取值拆成两个；
 * 其余是 glob 元字符，会让 Stryker 按通配去匹配文件（`apps/api/src/domain/*` 会从「改一行」
 * 放大成「整个 scope」），反引号与引号则是因为本模块不反转义 git 的引号形式路径。
 * 命中这些字符的路径不会被悄悄跳过，而是让整次执行失败（见 planScope 的 rejected）。
 */
const MUTATE_UNSAFE = /[,[\]{}*?!\\"]/;

/**
 * 把 `git diff -U0` 的输出解析成「文件 → 新增/修改行号」。
 *
 * 解析由 `@@ -a,b +c,d @@` 的计数驱动，而不是只看行首：一个 hunk 的体消耗 `a + b` 行
 * （`\ No newline at end of file` 不占计数），计数归零之前所有行都属于 hunk 体。这一点是必需的，
 * 因为新增行的内容本身可能以 `++ ` 开头（合法的 `++ counter;`），那一行的 diff 形式就是
 * `+++ counter;`——只看 `startsWith('+++ ')` 会把它当成新文件头，导致这个文件剩下的改动全部丢失、
 * 脚本报「没有改动」并绿着退出。
 *
 * @param {string} text 一份 git 统一 diff
 * @returns {{ path: string, lines: number[] }[]} 每个被改文件的新行号（升序、去重）
 */
export function parseUnifiedDiff(text) {
  /** @type {{ path: string, lines: number[] }[]} */
  const entries = [];
  let current = null;
  let newLine = 0;
  let bodyRemaining = 0;

  for (const line of text.split('\n')) {
    if (bodyRemaining > 0) {
      // hunk 体：`\ No newline at end of file` 不计入计数，其余每行消耗一行预算。
      if (line.startsWith('\\')) continue;
      if (current) {
        if (line.startsWith('+')) {
          current.lines.push(newLine);
          newLine += 1;
        } else if (line.startsWith(' ')) {
          newLine += 1;
        }
        // `-`（删除行）只占旧文件的行号，新文件行号不动。
      }
      bodyRemaining -= 1;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const file = stripDiffPathPrefix(line.slice(4).trim());
      current = isSafeRepoPath(file) ? { path: file, lines: [] } : null;
      if (current) entries.push(current);
      continue;
    }
    if (line.startsWith('@@')) {
      const hunk = parseHunkHeader(line);
      newLine = hunk.newStart;
      bodyRemaining = hunk.bodyLength;
    }
  }

  for (const entry of entries) {
    entry.lines = [...new Set(entry.lines)].sort((a, b) => a - b);
  }
  return entries;
}

/** `+++ b/foo` → `foo`；`+++ "b/foo bar"` → `foo bar`；`+++ /dev/null` → `/dev/null`。 */
function stripDiffPathPrefix(raw) {
  let file = raw;
  if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
  return file.startsWith('b/') ? file.slice(2) : file;
}

/**
 * 只接受仓库内的相对路径。
 *
 * diff 是可以手工构造的（`--diff-file` 就是给人喂的入口），而算出来的路径会被 Stryker 当作
 * `--mutate` 的值去改文件，所以带 `..` 段或绝对路径的条目一律丢弃。git 自己产出的 diff 里
 * 不会出现这两种：git 的路径总是规范化的，删除整个文件写成 `+++ /dev/null`，是绝对路径，
 * 被这一条顺带挡掉。
 */
function isSafeRepoPath(file) {
  return !path.isAbsolute(file) && !file.split('/').includes('..');
}

/**
 * 从 `@@ -10,0 +11,3 @@` 里取出新文件起始行号与 hunk 体总行数。
 *
 * count 省略时按 1 计（`@@ -1 +1 @@`），这是统一 diff 的规定。体行数是「旧行数 + 新行数」，
 * 因为体里既有增加行也有删除行。
 */
function parseHunkHeader(header) {
  const matched = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!matched) return { newStart: 0, bodyLength: 0 };
  const oldCount = matched[2] === undefined ? 1 : Number(matched[2]);
  const newCount = matched[4] === undefined ? 1 : Number(matched[4]);
  return { newStart: Number(matched[3]), bodyLength: oldCount + newCount };
}

/** 把连续行号合并成 `[start, end]` 区间。 */
function toRanges(lines) {
  const ranges = [];
  for (const line of lines) {
    const last = ranges.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

/**
 * 路径是否在 scope 的 glob 覆盖范围内。
 *
 * 除了 scope 自己的正则，还要排掉含隐藏段（以 `.` 开头的路径段）的文件：三份配置里的 glob 由
 * Stryker 的 `FileMatcher` 匹配，而它默认 `dot: false`，不收 dotfile。不排掉就会出现「脚本认为
 * 在范围内、Stryker 却找不到这个文件」的分歧。
 */
function isInScope(scope, file) {
  return scope.matches(file) && !file.split('/').some((segment) => segment.startsWith('.'));
}

/** 路径能不能安全地拼进 `--mutate`（见 MUTATE_UNSAFE）。 */
function isMutateSafePath(file) {
  return !MUTATE_UNSAFE.test(file);
}

/**
 * 生成 Stryker 的 `--mutate` 取值，形如 `apps/api/src/domain/clock.ts:11-13`。
 *
 * 单行也写成 `start-end`（`:11-11`）：Stryker 的 `MUTATION_RANGE_REGEX` 要求带上 `-endLine`，
 * `file:11` 这种省略形式不匹配它的语法。
 *
 * @param {{ path: string, lines: number[] }[]} entries
 * @param {keyof typeof SCOPES} scopeId
 */
export function toMutateArgs(entries, scopeId) {
  const scope = requireScope(scopeId);
  const args = [];
  for (const entry of entries) {
    if (!isInScope(scope, entry.path) || !isMutateSafePath(entry.path) || entry.lines.length === 0) continue;
    for (const [start, end] of toRanges(entry.lines)) args.push(`${entry.path}:${start}-${end}`);
  }
  return args;
}

/** 取出 scope，未知就抛错（错误信息里列出可选项）。 */
function requireScope(scopeId) {
  const scope = SCOPES[scopeId];
  if (!scope) throw new Error(`未知 scope：${scopeId}（可选：${Object.keys(SCOPES).join(' / ')}）`);
  return scope;
}

/**
 * 由 diff 文本算出「这次要跑哪些变异范围」，是脚本的全部决策，不产生副作用。
 *
 * `rejected` 是「在 scope 内、确实有改动行、但路径不能安全地拼进 --mutate」的文件。它必须让整次
 * 执行失败：这些文件的变异点会被静默漏掉，而调用方看到的仍然是一个绿。
 *
 * @param {{ scopeId: keyof typeof SCOPES, diffText: string, maxLines?: number }} options
 */
export function planScope({ scopeId, diffText, maxLines }) {
  const scope = requireScope(scopeId);
  const inScope = parseUnifiedDiff(diffText).filter((entry) => isInScope(scope, entry.path) && entry.lines.length > 0);
  const rejected = [...new Set(inScope.filter((entry) => !isMutateSafePath(entry.path)).map((entry) => entry.path))];
  const usable = inScope.filter((entry) => isMutateSafePath(entry.path));
  const lineCount = usable.reduce((total, entry) => total + entry.lines.length, 0);
  const limit = maxLines ?? scope.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
  return { scope, args: toMutateArgs(usable, scopeId), lineCount, maxLines: limit, tooLarge: lineCount > limit, rejected };
}

const USAGE = `用法：node scripts/mutation-scope.mjs --scope <api|web|bin> [选项]

选项：
  --base <ref>        与哪个 ref 比较（默认 main；CI 上通常传 origin/main）
  --diff-file <path>  直接读一份 diff 文件，不调用 git
  --max-lines <n>     改动行数上限，超过就拒绝执行（默认见 DEFAULT_MAX_CHANGED_LINES）
  --force-large       越过上限继续执行
  --run               真的执行 stryker；不加则只打印将要执行的范围与命令
  -h, --help          显示本说明`;

/** 解析命令行参数；未知参数抛错。 */
export function parseArgv(argv) {
  const options = { scope: null, base: 'main', diffFile: null, maxLines: undefined, forceLarge: false, run: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scope') options.scope = argv[++i];
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--diff-file') options.diffFile = argv[++i];
    else if (arg === '--max-lines') {
      const value = Number(argv[++i]);
      // 少了取值会得到 NaN，而 NaN 参与比较恒为 false，会静默关掉护栏——这里显式拒绝。
      if (!Number.isInteger(value) || value < 0) throw new Error(`--max-lines 需要一个非负整数，收到：${argv[i]}`);
      options.maxLines = value;
    }
    else if (arg === '--force-large') options.forceLarge = true;
    else if (arg === '--run') options.run = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** 取「base 与 HEAD 的合并基点」，这样在分支上不会把 base 分支自己的提交算进来。 */
function mergeBaseWith(ref) {
  return execFileSync('git', ['merge-base', ref, 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/**
 * 默认的 diff 来源：git。
 *
 * `-c core.quotePath=false` 是为了让非 ASCII 路径按原样输出而不是转义成 `\346...`。
 * `-U0` 减少解析量，但解析器由 hunk 计数驱动、对带上下文行同样正确，所以这里只是省字节。
 *
 * 已知局限：`git diff` 看不到未跟踪的新文件，本地刚新建的源文件要先 `git add` 才会进范围。
 */
function readDiffFromGit({ base }) {
  const from = mergeBaseWith(base);
  return execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', from], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 默认的 diff 来源：文件（绝对路径按原样用，相对路径相对仓库根）。 */
function readDiffFromFile({ diffFile }) {
  return readFileSync(path.resolve(repoRoot, diffFile), 'utf8');
}

/**
 * 默认的执行方式：调用本仓库安装的 stryker。
 *
 * 直接执行 `node_modules/.bin/stryker` 而不走 `pnpm exec`：后者会先做依赖状态检查，缺依赖时
 * 自作主张跑 `pnpm install`，在 store 不可写的机器上（本仓库的沙箱就是这样）报出来的是一句
 * 看不出根因的 SQLite 错。直接起二进制时缺依赖会得到下面那句明确的「先跑一次 pnpm install」。
 * 注意这只覆盖 stryker 自身的启动：bin 分支的 `pnpm build` 与三条配置里的 `pnpm --filter ...`
 * 仍会走 pnpm，所以下面显式关掉了它的依赖检查。
 *
 * `--mutate` 在命令行上会**整体替换**配置里的 mutate 数组（`@stryker-mutator/util` 的 deepMerge
 * 对数组直接覆盖），所以这里传的值就是全部变异范围。
 *
 * @param {{ scope: typeof SCOPES[keyof typeof SCOPES], mutateArgs: string[] }} invocation
 * @param {{ exec?: Function, exists?: (file: string) => boolean }} [deps] 仅测试注入
 */
export function runStrykerWithStrykerCli({ scope, mutateArgs }, deps = {}) {
  const exec = deps.exec ?? execFileSync;
  const exists = deps.exists ?? existsSync;

  const env = { ...process.env };
  for (const name of scope.dropEnv ?? []) delete env[name];
  // pnpm 11 起 verifyDepsBeforeRun 的默认值是 install。关掉它，免得任何一次 pnpm 调用都去做
  // 依赖状态检查、在缺 node_modules 的检出里尝试联网安装。
  env.npm_config_verify_deps_before_run = 'false';

  const strykerBin = path.join(repoRoot, 'node_modules', '.bin', 'stryker');
  if (!exists(strykerBin)) {
    throw new Error(`找不到 ${strykerBin}，先在仓库根跑一次 pnpm install`);
  }

  const args = ['run'];
  if (scope.config) args.push(scope.config);
  args.push('--mutate', mutateArgs.join(','));

  if (scope.buildFirst) exec('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit', env });
  exec(strykerBin, args, { cwd: repoRoot, stdio: 'inherit', env });
  return 0;
}

/**
 * 入口。依赖都从 `deps` 注入，方便用例在不碰 git、不真跑 stryker 的前提下覆盖决策与参数解析；
 * 真正的 git 解析与 stryker 调用由端到端用例覆盖。
 *
 * @param {string[]} argv
 * @param {{
 *   readDiffText?: (options: any) => string,
 *   runStryker?: (invocation: { scope: any, mutateArgs: string[] }) => number,
 *   log?: (message: string) => void,
 * }} [deps]
 * @returns {number} 进程退出码
 */
export function main(argv, deps = {}) {
  const log = deps.log ?? ((message) => console.log(message));
  const runStryker = deps.runStryker ?? runStrykerWithStrykerCli;
  const readDiffText = deps.readDiffText ?? ((options) => (options.diffFile ? readDiffFromFile(options) : readDiffFromGit(options)));

  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    log(error.message);
    log(USAGE);
    return 1;
  }
  if (options.help || !options.scope) {
    log(USAGE);
    return options.help ? 0 : 1;
  }
  if (!SCOPES[options.scope]) {
    log(`未知 scope：${options.scope}（可选：${Object.keys(SCOPES).join(' / ')}）`);
    return 1;
  }

  let diffText;
  try {
    diffText = readDiffText(options);
  } catch (error) {
    log(`读取 diff 失败（--base ${options.base}）：${error.message}`);
    return 1;
  }

  const plan = planScope({ scopeId: options.scope, diffText, maxLines: options.maxLines });

  // 先报「有文件跑不了」，再谈「没有改动」：否则一个含逗号的路径会让整次执行静默变绿。
  if (plan.rejected.length > 0) {
    log(`以下路径在 ${plan.scope.label} 范围内，但含有不能安全地传给 --mutate 的字符：`);
    for (const file of plan.rejected) log(`  ${file}`);
    log('请对它们跑一次全量（见 docs/development.md 的三个 test:mutation:* 入口）。');
    return 2;
  }

  if (plan.args.length === 0) {
    log(`本次 diff 在 ${plan.scope.label} 范围内没有改动，跳过变异测试。`);
    log('（git diff 看不到未跟踪的新文件：刚新建的源文件要先 git add）');
    return 0;
  }

  log(`scope=${options.scope}（${plan.scope.label}）改动 ${plan.lineCount} 行，变异范围：`);
  for (const arg of plan.args) log(`  ${arg}`);

  if (plan.tooLarge && !options.forceLarge) {
    log(`改动行数 ${plan.lineCount} 超过上限 ${plan.maxLines}。`);
    log('这么大的改动请跑全量（见 docs/development.md 的三个 test:mutation:* 入口），或加 --max-lines 显式放宽。');
    return 2;
  }

  if (!options.run) {
    log('（未加 --run，只打印，不执行）');
    return 0;
  }

  try {
    return runStryker({ scope: plan.scope, mutateArgs: plan.args });
  } catch (error) {
    log(`stryker 执行失败：${error.message}`);
    return typeof error.status === 'number' ? error.status : 1;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

/** 判断本模块是不是被 `node scripts/mutation-scope.mjs` 直接执行的（跟随符号链接）。 */
export function isDirectRun(argv1, moduleUrl) {
  if (argv1 === undefined) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}
