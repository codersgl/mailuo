/**
 * `scripts/mutation-scope.mjs` 的单元测试与一条真实 git 的集成用例。
 *
 * 这个脚本的全部风险都在两处：diff 的解析口径（行号数错一位，变异测试就去改别的行，而结果
 * 看起来仍然是「跑过了」），以及「到底给 Stryker 传了什么」。所以这里对每种 diff 形状都钉一条
 * 用例，并且直接断言传给 stryker 的 argv 与 env，而不是只断言注入替身收到的对象。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_CHANGED_LINES,
  SCOPES,
  isDirectRun,
  main,
  parseArgv,
  parseUnifiedDiff,
  planScope,
  runStrykerWithStrykerCli,
  toMutateArgs,
} from './mutation-scope.mjs';

/** 造一份最小可用的 git diff 片段。 */
function diff(...lines) {
  return `${lines.join('\n')}\n`;
}

/** 本测试文件在 scripts/ 下，仓库根就是它的上一级（用于断言各 scope 的执行目录）。 */
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 收集 exec 调用的替身：把 file / args / cwd 都留下来供断言。 */
function captureExec(calls) {
  return (file, args, options) => {
    calls.push({ file, args, env: options.env, cwd: options.cwd });
    return '';
  };
}

test('单个 hunk 里的连续新增行合并成一个范围', () => {
  const text = diff(
    'diff --git a/apps/api/src/domain/clock.ts b/apps/api/src/domain/clock.ts',
    'index 111..222 100644',
    '--- a/apps/api/src/domain/clock.ts',
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -10,0 +11,3 @@',
    '+a',
    '+b',
    '+c',
  );
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/clock.ts', lines: [11, 12, 13] }]);
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), ['src/domain/clock.ts:11-13']);
});

test('hunk 体内以 "++ " 开头的新增行不被当成文件头', () => {
  // `++ counter;` 这一行的 diff 形式就是 `+++ counter;`，只看行首会把它当成新文件，
  // 于是真文件剩下的改动全部丢失、脚本报「没有改动」并绿着退出（审核 B1）。
  const text = diff(
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -1,0 +2,3 @@',
    '+++ counter;',
    '+const a = 1;',
    '+const b = 2;',
  );
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/clock.ts', lines: [2, 3, 4] }]);
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), ['src/domain/clock.ts:2-4']);
});

test('独立 hunk 头不会被上一条 hunk 的预算吃掉', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -1,0 +2,1 @@',
    '+++ counter;',
    '@@ -10,0 +11,1 @@',
    '+later',
  );
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/clock.ts', lines: [2, 11] }]);
});

test('分开的 hunk 产生分开的范围，单行范围写成 start-end', () => {
  const text = diff(
    '--- a/apps/api/src/domain/clock.ts',
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -10,0 +11,2 @@',
    '+x',
    '+y',
    '@@ -30,0 +33,1 @@',
    '+z',
  );
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), [
    'src/domain/clock.ts:11-12',
    'src/domain/clock.ts:33-33',
  ]);
});

test('不相邻的行不合并', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -10,0 +11,2 @@',
    '+x',
    '+y',
    '@@ -14,0 +15,1 @@',
    '+z',
  );
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), [
    'src/domain/clock.ts:11-12',
    'src/domain/clock.ts:15-15',
  ]);
});

test('一个 hunk 里增删混合时，只有新增行进入范围且行号正确', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -5,3 +5,3 @@',
    '-old a',
    '+new a',
    ' same',
    '-old b',
    '+new b',
  );
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/clock.ts', lines: [5, 7] }]);
});

test('纯删除的 hunk 不产生变异范围（删除行在新文件里没有行号）', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -5,3 +4,0 @@',
    '-a',
    '-b',
    '-c',
  );
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/clock.ts', lines: [] }]);
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), []);
});

test('删除整个文件（+++ /dev/null）被跳过', () => {
  const text = diff(
    '--- a/apps/api/src/domain/clock.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-a',
    '-b',
  );
  assert.deepEqual(parseUnifiedDiff(text), []);
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), []);
});

test('匹配 scope 的越界路径进 rejected，而不是被静默丢掉', () => {
  // 解析层不再丢弃它（审核 L3：丢弃等于静默漏检，脚本会报「没有改动」并绿着退出）。
  const text = diff('+++ b/apps/api/src/domain/../../../../etc/evil.ts', '@@ -1,0 +1,1 @@', '+a');
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/../../../../etc/evil.ts', lines: [1] }]);
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), []);

  const plan = planScope({ scopeId: 'api', diffText: text });
  assert.deepEqual(plan.rejected, ['apps/api/src/domain/../../../../etc/evil.ts']);
  assert.deepEqual(plan.args, []);

  // `.` 段同样不该被当成 dotfile 静默排掉：它会被 path.posix.relative 归一化掉，让实际变异的
  // 文件与 diff 声明的路径不再一致。
  const dotted = planScope({ scopeId: 'api', diffText: diff('+++ b/apps/api/src/domain/./x.ts', '@@ -1,0 +1,1 @@', '+a') });
  assert.deepEqual(dotted.rejected, ['apps/api/src/domain/./x.ts']);
  assert.deepEqual(dotted.args, []);
});

test('scope 之外的绝对路径既不在 args 也不在 rejected（它本来就不在范围内）', () => {
  const text = diff('+++ /etc/passwd', '@@ -1,0 +1,1 @@', '+b');
  assert.deepEqual(parseUnifiedDiff(text), [{ path: '/etc/passwd', lines: [1] }]);
  const plan = planScope({ scopeId: 'api', diffText: text });
  assert.deepEqual(plan.rejected, []);
  assert.deepEqual(plan.args, []);
});

test('scope 的 cwd 与 matches 不一致时也不会产出带 .. 的 --mutate', () => {
  // 防御性用例：当前三个 scope 都不会这样（api 的 matches 保证路径都在 apps/api 下）。但将来给某个
  // scope 加 cwd 而 matches 放宽时，path.posix.relative 会产出 '../../web/...'，必须在转换后再验一次。
  SCOPES.__probe = { label: '探针', cwd: 'apps/api', config: null, matches: (file) => file.startsWith('apps/') };
  try {
    const text = diff('+++ b/apps/web/src/lib/format.ts', '@@ -1,0 +1,1 @@', '+a');
    assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), '__probe'), []);
    assert.deepEqual(planScope({ scopeId: '__probe', diffText: text }).rejected, ['apps/web/src/lib/format.ts']);
  } finally {
    delete SCOPES.__probe;
  }
});

test('带上下文行的 diff（非 -U0）也数对行号', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -1,3 +1,4 @@',
    ' context before',
    '+added',
    ' context after',
  );
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/clock.ts', lines: [2] }]);
});

test('hunk 头省略 count 时按 1 计', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  );
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/clock.ts', lines: [1] }]);
});

test('文件末尾没有换行的那一行不影响计数', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -1,0 +2,1 @@',
    '+only',
    '\\ No newline at end of file',
  );
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/clock.ts', lines: [2] }]);
});

test('新增文件里的改动行从第 1 行起算', () => {
  const text = diff(
    '--- /dev/null',
    '+++ b/apps/api/src/domain/derive.ts',
    '@@ -0,0 +1,2 @@',
    '+a',
    '+b',
  );
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/derive.ts', lines: [1, 2] }]);
});

test('带引号的路径会剥掉外层引号', () => {
  const text = diff('+++ "b/apps/api/src/domain/clock.ts"', '@@ -1,0 +1,1 @@', '+a');
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'apps/api/src/domain/clock.ts', lines: [1] }]);
});

test('scope 之外的路径被过滤掉', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -1,0 +1,1 @@',
    '+a',
    '+++ b/apps/api/src/routes/tasks.ts',
    '@@ -1,0 +1,1 @@',
    '+b',
    '+++ b/apps/web/src/domain/board.ts',
    '@@ -1,0 +1,1 @@',
    '+c',
  );
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), ['src/domain/clock.ts:1-1']);
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'web'), ['apps/web/src/domain/board.ts:1-1']);
});

test('api 的 server.ts 与 web 的 tsx 各自在范围内', () => {
  const text = diff(
    '+++ b/apps/api/src/server.ts',
    '@@ -1,0 +2,1 @@',
    '+a',
    '+++ b/apps/web/src/lib/tree.tsx',
    '@@ -1,0 +3,1 @@',
    '+b',
    '+++ b/apps/web/src/components/BoardView.tsx',
    '@@ -1,0 +4,1 @@',
    '+c',
  );
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), ['src/server.ts:2-2']);
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'web'), ['apps/web/src/lib/tree.tsx:3-3']);
});

test('bin scope 只认 bin/mailuo.mjs 本身', () => {
  const text = diff(
    '+++ b/bin/mailuo.mjs',
    '@@ -1,0 +6,1 @@',
    '+a',
    '+++ b/bin/mailuo.test.mjs',
    '@@ -1,0 +7,1 @@',
    '+b',
  );
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'bin'), ['bin/mailuo.mjs:6-6']);
});

test('隐藏文件被排除，与 Stryker FileMatcher 的 dot:false 一致', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/.hidden.ts',
    '@@ -1,0 +1,1 @@',
    '+a',
    '+++ b/apps/api/src/domain/clock.ts',
    '@@ -1,0 +2,1 @@',
    '+b',
  );
  assert.deepEqual(toMutateArgs(parseUnifiedDiff(text), 'api'), ['src/domain/clock.ts:2-2']);
});

test('三个 scope 的 diff 互不串台', () => {
  const text = diff(
    '+++ b/apps/api/src/domain/net.ts',
    '@@ -1,0 +1,1 @@',
    '+a',
    '+++ b/apps/web/src/lib/format.ts',
    '@@ -1,0 +2,1 @@',
    '+b',
    '+++ b/bin/mailuo.mjs',
    '@@ -1,0 +3,1 @@',
    '+c',
  );
  const entries = parseUnifiedDiff(text);
  assert.deepEqual(toMutateArgs(entries, 'api'), ['src/domain/net.ts:1-1']);
  assert.deepEqual(toMutateArgs(entries, 'web'), ['apps/web/src/lib/format.ts:2-2']);
  assert.deepEqual(toMutateArgs(entries, 'bin'), ['bin/mailuo.mjs:3-3']);
});

test('planScope：范围内没有改动时没有变异范围', () => {
  const text = diff('+++ b/apps/web/src/components/BoardView.tsx', '@@ -1,0 +1,1 @@', '+a');
  const plan = planScope({ scopeId: 'api', diffText: text });
  assert.deepEqual(plan.args, []);
  assert.deepEqual(plan.rejected, []);
  assert.equal(plan.lineCount, 0);
  assert.equal(plan.tooLarge, false);
});

test('planScope：含逗号或 glob 元字符的路径被列为 rejected，且不生成范围', () => {
  // 逗号会被 Stryker CLI 的 createSplitter(',') 拆开：`a,b.ts` 会变成两个垃圾片段，
  // 而 `*.ts` 这种会从「改一行」放大成「整个 scope」（审核 M1）。
  const text = diff(
    '+++ b/apps/api/src/domain/a,b.ts',
    '@@ -1,0 +1,1 @@',
    '+a',
    '+++ b/apps/api/src/domain/*,x.ts',
    '@@ -1,0 +2,1 @@',
    '+b',
  );
  const plan = planScope({ scopeId: 'api', diffText: text });
  assert.deepEqual(plan.rejected, ['apps/api/src/domain/a,b.ts', 'apps/api/src/domain/*,x.ts']);
  assert.deepEqual(plan.args, []);
});

test('planScope：超过改动行上限时标记 tooLarge，bin 的上限更低', () => {
  const five = Array.from({ length: 5 }, (_, i) => `+line ${i}`);
  const apiText = diff('+++ b/apps/api/src/domain/clock.ts', '@@ -1,0 +1,5 @@', ...five);
  assert.equal(planScope({ scopeId: 'api', diffText: apiText, maxLines: 3 }).tooLarge, true);
  assert.equal(planScope({ scopeId: 'api', diffText: apiText, maxLines: 5 }).tooLarge, false);

  // 同样的 40 行：api 的默认上限（200）放行，bin 的 30 行上限拒绝——这才是「bin 上限更低」的实际后果。
  const forty = Array.from({ length: 40 }, (_, i) => `+line ${i}`);
  const binText = diff('+++ b/bin/mailuo.mjs', '@@ -1,0 +1,40 @@', ...forty);
  const binPlan = planScope({ scopeId: 'bin', diffText: binText });
  assert.equal(binPlan.maxLines, SCOPES.bin.maxChangedLines);
  assert.equal(binPlan.tooLarge, true);
  assert.equal(planScope({ scopeId: 'api', diffText: apiText }).tooLarge, false);
  assert.ok(SCOPES.bin.maxChangedLines < DEFAULT_MAX_CHANGED_LINES);
});

test('main：范围内没有改动时跳过执行并提示未跟踪文件', () => {
  const logs = [];
  let ran = 0;
  const code = main(['--scope', 'api', '--run'], {
    readDiffText: () => diff('+++ b/apps/web/src/components/BoardView.tsx', '@@ -1,0 +1,1 @@', '+a'),
    runStryker: () => {
      ran += 1;
      return 0;
    },
    log: (message) => logs.push(message),
  });
  assert.equal(code, 0);
  assert.equal(ran, 0);
  assert.match(logs.join('\n'), /没有改动/);
  assert.match(logs.join('\n'), /git add/);
});

test('main：默认只打印不执行，--run 才调用 stryker 并传对范围', () => {
  const diffText = diff('+++ b/apps/api/src/domain/clock.ts', '@@ -1,0 +3,2 @@', '+a', '+b');
  const printed = [];
  assert.equal(main(['--scope', 'api'], { readDiffText: () => diffText, runStryker: () => 0, log: (m) => printed.push(m) }), 0);
  // api 的路径在打印时是相对 apps/api 的（Stryker 就在那里执行），日志里同时给出 cwd。
  assert.match(printed.join('\n'), /src\/domain\/clock\.ts:3-4/);
  assert.match(printed.join('\n'), /在 apps\/api 下执行/);
  assert.match(printed.join('\n'), /未加 --run/);

  const invocations = [];
  const code = main(['--scope', 'api', '--run'], {
    readDiffText: () => diffText,
    runStryker: (invocation) => {
      invocations.push(invocation);
      return 0;
    },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0].mutateArgs, ['src/domain/clock.ts:3-4']);
  assert.equal(invocations[0].scope, SCOPES.api);
});

test('main：超过上限时拒绝执行并返回 2', () => {
  const manyLines = Array.from({ length: 4 }, (_, i) => `+line ${i}`);
  const diffText = diff('+++ b/apps/api/src/domain/clock.ts', '@@ -1,0 +1,4 @@', ...manyLines);
  const logs = [];
  let ran = 0;
  const code = main(['--scope', 'api', '--run', '--max-lines', '3'], {
    readDiffText: () => diffText,
    runStryker: () => {
      ran += 1;
      return 0;
    },
    log: (m) => logs.push(m),
  });
  assert.equal(code, 2);
  assert.equal(ran, 0);
  assert.match(logs.join('\n'), /超过上限|全量/);
});

test('main：--force-large 可以越过上限', () => {
  const manyLines = Array.from({ length: 4 }, (_, i) => `+line ${i}`);
  const diffText = diff('+++ b/apps/api/src/domain/clock.ts', '@@ -1,0 +1,4 @@', ...manyLines);
  let ran = 0;
  const code = main(['--scope', 'api', '--run', '--max-lines', '3', '--force-large'], {
    readDiffText: () => diffText,
    runStryker: () => {
      ran += 1;
      return 0;
    },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(ran, 1);
});

test('main：有路径不能安全传给 --mutate 时返回 2，且不执行', () => {
  const diffText = diff('+++ b/apps/api/src/domain/a,b.ts', '@@ -1,0 +1,1 @@', '+a');
  const logs = [];
  let ran = 0;
  const code = main(['--scope', 'api', '--run'], {
    readDiffText: () => diffText,
    runStryker: () => {
      ran += 1;
      return 0;
    },
    log: (m) => logs.push(m),
  });
  assert.equal(code, 2);
  assert.equal(ran, 0);
  assert.match(logs.join('\n'), /a,b\.ts/);
  assert.match(logs.join('\n'), /相对仓库根/);
});

test('main：匹配 scope 的 .. 路径也返回 2，不会报成「没有改动」', () => {
  // 审核 L3 的原始复现：这条路径同时匹配 api 的 matches 又有改动行，旧实现会 exit 0 并打印
  // 「没有改动，跳过变异测试」。
  const diffText = diff('+++ b/apps/api/src/domain/../../secret.ts', '@@ -1,0 +1,1 @@', '+x');
  const logs = [];
  let ran = 0;
  const code = main(['--scope', 'api', '--run'], {
    readDiffText: () => diffText,
    runStryker: () => {
      ran += 1;
      return 0;
    },
    log: (m) => logs.push(m),
  });
  assert.equal(code, 2);
  assert.equal(ran, 0);
  assert.match(logs.join('\n'), /secret\.ts/);
  assert.doesNotMatch(logs.join('\n'), /没有改动/);
});

test('main：--help 打印用法并返回 0', () => {
  const logs = [];
  assert.equal(main(['--help'], { readDiffText: () => '', runStryker: () => 0, log: (m) => logs.push(m) }), 0);
  assert.match(logs.join('\n'), /用法/);
});

test('main：未知 scope 与未知参数都返回 1，且不执行', () => {
  let ran = 0;
  const runStryker = () => {
    ran += 1;
    return 0;
  };
  assert.equal(main(['--scope', 'nope'], { readDiffText: () => '', runStryker, log: () => {} }), 1);
  assert.equal(main(['--scope', 'api', '--wat'], { readDiffText: () => '', runStryker, log: () => {} }), 1);
  assert.equal(main([], { readDiffText: () => '', runStryker, log: () => {} }), 1);
  assert.equal(ran, 0);
});

test('main：--max-lines 缺取值或不是非负整数时返回 1，不静默关掉护栏', () => {
  let ran = 0;
  const runStryker = () => {
    ran += 1;
    return 0;
  };
  for (const argv of [
    ['--scope', 'api', '--max-lines'],
    ['--scope', 'api', '--max-lines', 'abc'],
    ['--scope', 'api', '--max-lines', '-1'],
  ]) {
    assert.equal(main(argv, { readDiffText: () => '', runStryker, log: () => {} }), 1, argv.join(' '));
  }
  assert.equal(ran, 0);
});

test('main：--diff-file 走真实的读文件分支（绝对路径）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mutation-scope-diff-'));
  try {
    const file = path.join(dir, 'change.diff');
    writeFileSync(file, diff('+++ b/apps/api/src/domain/clock.ts', '@@ -1,0 +2,1 @@', '+a'));
    const logs = [];
    let ran = 0;
    const code = main(['--scope', 'api', '--diff-file', file, '--run'], {
      runStryker: () => {
        ran += 1;
        return 0;
      },
      log: (m) => logs.push(m),
    });
    assert.equal(code, 0);
    assert.equal(ran, 1);
    assert.match(logs.join('\n'), /clock\.ts:2-2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main：--base 是不存在的 ref 时返回 1 并给出原因', () => {
  const logs = [];
  const code = main(['--scope', 'api', '--base', 'definitely-not-a-ref-xyz'], { log: (m) => logs.push(m) });
  assert.equal(code, 1);
  assert.match(logs.join('\n'), /读取 diff 失败/);
});

test('main：--base HEAD 走真实的 git 分支且不报错', () => {
  // 与工作区比较，结果取决于当前有没有未提交改动，所以只断言「没有在读 diff 这一步失败」。
  const code = main(['--scope', 'bin', '--base', 'HEAD'], { log: () => {} });
  assert.notEqual(code, 1);
});

test('parseArgv：默认值与全部选项', () => {
  assert.deepEqual(parseArgv(['--scope', 'api']), {
    scope: 'api',
    base: 'main',
    diffFile: null,
    maxLines: undefined,
    forceLarge: false,
    run: false,
    help: false,
  });
  assert.deepEqual(parseArgv(['--scope', 'web', '--base', 'origin/main', '--diff-file', 'x.diff', '--max-lines', '7', '--force-large', '--run']), {
    scope: 'web',
    base: 'origin/main',
    diffFile: 'x.diff',
    maxLines: 7,
    forceLarge: true,
    run: true,
    help: false,
  });
});

test('runStrykerWithStrykerCli：web scope 在仓库根跑，传对配置与 --mutate', () => {
  const calls = [];
  const code = runStrykerWithStrykerCli(
    { scope: SCOPES.web, mutateArgs: ['apps/web/src/lib/format.ts:3-4'] },
    { exec: captureExec(calls), exists: () => true },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /node_modules[/\\]\.bin[/\\]stryker$/);
  assert.deepEqual(calls[0].args, ['run', 'stryker.web.config.json', '--mutate', 'apps/web/src/lib/format.ts:3-4']);
  assert.equal(calls[0].cwd, repoRoot);
  // pnpm 11 起 verifyDepsBeforeRun 默认 install，必须显式关掉，否则每次调用都可能去联网安装。
  assert.equal(calls[0].env.npm_config_verify_deps_before_run, 'false');
});

test('runStrykerWithStrykerCli：api 在 apps/api 下跑它自己的 stryker 与配置', () => {
  const calls = [];
  runStrykerWithStrykerCli(
    { scope: SCOPES.api, mutateArgs: ['src/domain/clock.ts:1-1'] },
    { exec: captureExec(calls), exists: () => true },
  );
  assert.equal(calls.length, 1);
  // runner 与 vitest 必须是同一个实例，所以这一套装在 apps/api，执行目录也必须是它（D91）。
  assert.equal(calls[0].cwd, path.join(repoRoot, 'apps', 'api'));
  assert.match(calls[0].file, /apps[/\\]api[/\\]node_modules[/\\]\.bin[/\\]stryker$/);
  assert.deepEqual(calls[0].args, ['run', 'stryker.config.json', '--mutate', 'src/domain/clock.ts:1-1']);
});

test('runStrykerWithStrykerCli：bin 在仓库根先 build，并清掉代理环境变量', () => {
  const calls = [];
  const previousProxy = process.env.NODE_USE_ENV_PROXY;
  process.env.NODE_USE_ENV_PROXY = '1';
  try {
    runStrykerWithStrykerCli({ scope: SCOPES.bin, mutateArgs: ['bin/mailuo.mjs:5-5'] }, { exec: captureExec(calls), exists: () => true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].file, 'pnpm');
    assert.deepEqual(calls[0].args, ['build']);
    assert.equal(calls[0].cwd, repoRoot);
    assert.equal(calls[1].cwd, repoRoot);
    assert.deepEqual(calls[1].args, ['run', 'stryker.bin.config.json', '--mutate', 'bin/mailuo.mjs:5-5']);
    // bin 的进程级用例里有一条断言 stderr 为空，导出的 NODE_USE_ENV_PROXY 会让它失败。
    assert.equal('NODE_USE_ENV_PROXY' in calls[1].env, false);
  } finally {
    if (previousProxy === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = previousProxy;
  }
});

test('runStrykerWithStrykerCli：缺 stryker 可执行文件时报出路径与可操作的提示', () => {
  assert.throws(
    () => runStrykerWithStrykerCli({ scope: SCOPES.api, mutateArgs: ['a.ts:1-1'] }, { exec: () => '', exists: () => false }),
    (error) =>
      /apps[/\\]api[/\\]node_modules[/\\]\.bin[/\\]stryker/.test(error.message) && /pnpm install/.test(error.message),
  );
});

test('isDirectRun：只有直接执行本模块时才为真', () => {
  const moduleUrl = new URL('./mutation-scope.mjs', import.meta.url).href;
  assert.equal(isDirectRun(fileURLToPath(moduleUrl), moduleUrl), true);
  assert.equal(isDirectRun(undefined, moduleUrl), false);
  assert.equal(isDirectRun('/no/such/file.mjs', moduleUrl), false);
  assert.equal(isDirectRun(import.meta.filename, moduleUrl), false);
});

test('main：runStryker 抛错时返回它的 status，没有 status 就返回 1', () => {
  const diffText = diff('+++ b/apps/api/src/domain/clock.ts', '@@ -1,0 +2,1 @@', '+a');
  const base = { readDiffText: () => diffText, log: () => {} };
  assert.equal(
    main(['--scope', 'api', '--run'], {
      ...base,
      runStryker: () => {
        const error = new Error('boom');
        error.status = 3;
        throw error;
      },
    }),
    3,
  );
  assert.equal(
    main(['--scope', 'api', '--run'], {
      ...base,
      runStryker: () => {
        throw new Error('boom');
      },
    }),
    1,
  );
});

test('作为命令行直接执行时走真实入口，并把退出码交给进程', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mutation-scope-cli-'));
  try {
    const file = path.join(dir, 'change.diff');
    writeFileSync(file, diff('+++ b/apps/api/src/domain/clock.ts', '@@ -1,0 +2,1 @@', '+a'));
    const script = fileURLToPath(new URL('./mutation-scope.mjs', import.meta.url));

    const out = execFileSync(process.execPath, [script, '--scope', 'api', '--diff-file', file], { encoding: 'utf8' });
    assert.match(out, /clock\.ts:2-2/);
    assert.match(out, /未加 --run/);

    assert.throws(
      () => execFileSync(process.execPath, [script, '--scope', 'nope'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => error.status === 1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 git 产出的 diff 也解析正确（含以 ++ 开头的行）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mutation-scope-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q', '.');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(path.join(dir, 'counter.ts'), 'let counter = 0;\n');
    git('add', '-A');
    git('commit', '-qm', 'c1');
    writeFileSync(path.join(dir, 'counter.ts'), 'let counter = 0;\n++ counter;\nconst a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'c2');

    const text = git('-c', 'core.quotePath=false', 'diff', '-U0', 'HEAD~1', 'HEAD');
    assert.deepEqual(parseUnifiedDiff(text), [{ path: 'counter.ts', lines: [2, 3] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
