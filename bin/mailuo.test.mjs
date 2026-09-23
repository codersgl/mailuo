/**
 * `bin/mailuo.mjs` 的单元测试与进程级验证。
 *
 * 这里用 Node 自带的测试运行器（`node --test`），而不是各工作区里的 vitest：被测文件在包根
 * 的 `bin/` 下，不属于任何一个工作区包，用 node:test 就不必为了一个启动器在工作区里再拼
 * 一套模块解析。根 `package.json` 的 `test` 脚本把自己与 `pnpm -r test` 串起来跑。
 *
 * 两类用例：
 * - 函数级：参数解析、优先级、URL 与入口判定。
 * - 进程级：真的以子进程起服务；真的通过符号链接调用 bin（模拟 npm/pnpm 全局安装后的布局）。
 *   第二类不能省：第一版就是因为「入口判定」没有被任何用例走到，符号链接下命令静默不执行
 *   却让全部用例保持绿色。
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  browserHost,
  defaultDbPath,
  fetchLatestVersion,
  findFreePort,
  formatUrl,
  isDirectRun,
  isNewerVersion,
  main,
  parseArgs,
  parsePort,
  parseVersion,
  probePort,
  reportUpdate,
  resolveConfig,
} from './mailuo.mjs';

const BIN_PATH = fileURLToPath(new URL('./mailuo.mjs', import.meta.url));

/** 本包 package.json：用例据此造一个「更新」的版本号，而不是把 9.9.9 写死。 */
const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 造一个一定比当前版本新的版本号。 */
function nextMajorVersion() {
  return `${Number(String(PACKAGE_JSON.version).split('.')[0]) + 1}.0.0`;
}

/** registry 用例的默认响应：一个 JSON 体加状态码。 */
function respondJson(status, body) {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

/**
 * 起一个假的 npm registry。用真 socket 而不是给 fetch 打桩：URL 拼接、超时与响应解析都要被
 * 真的走到，打桩会把这几步一起绕过去。
 */
async function startRegistry(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 临时接管 console.log，返回收集到的行与还原函数。 */
function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

/** 只留必要的键：调用方的环境里可能有 PORT/HOST/KANBAN_DB_PATH，不隔离会串味。 */
function env(overrides = {}) {
  return { HOME: '/home/tester', ...overrides };
}

/**
 * 子进程共用的环境变量：默认关掉版本提示，只有专门验证它的那条用例才联网。
 * `process.env` 在前，保证调用方传的覆盖值生效。
 */
function childEnv(overrides) {
  return { ...process.env, MAILUO_NO_UPDATE_CHECK: '1', ...overrides };
}

/** 在 127.0.0.1 上占一个随机端口，返回端口号与关掉它的函数。 */
async function occupyPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    release: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 跑一次 bin 子进程并收集结果，模拟用户敲命令。 */
function runBin(args, envOverrides = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN_PATH, ...args],
      { encoding: 'utf8', timeout: 30_000, env: childEnv(envOverrides) },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

/** 真起一个 CLI 子进程，返回句柄：等某段输出、拿全部输出、收尾。 */
function startCli(args, envOverrides = {}) {
  const child = spawn(process.execPath, [BIN_PATH, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(envOverrides),
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));

  return {
    output: () => output,
    exited,
    /** 等到输出里出现 text（或超时）。 */
    async waitFor(text, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (output.includes(text)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`等不到输出「${text}」，当前输出：\n${output}`);
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
      await exited;
    },
  };
}

test('parseArgs：值选项、开关与短名', () => {
  assert.deepEqual(parseArgs([]), {
    values: {},
    flags: { help: false, version: false, open: true, hasOpenFlag: false },
  });
  assert.deepEqual(parseArgs(['--port', '3010', '--db', 'a.db']).values, { port: '3010', db: 'a.db' });
  assert.equal(parseArgs(['-p', '3010']).values.port, '3010');
  assert.equal(parseArgs(['--port=3010']).values.port, '3010');
  assert.equal(parseArgs(['--db=./a.db']).values.db, './a.db');
  assert.equal(parseArgs(['-p3010']).values.port, '3010');
  assert.equal(parseArgs(['--no-open']).flags.open, false);
  assert.equal(parseArgs(['--no-open', '--open']).flags.open, true);
  assert.equal(parseArgs(['--no-open']).flags.hasOpenFlag, true);
  assert.equal(parseArgs([]).flags.hasOpenFlag, false);
  assert.equal(parseArgs(['--help']).flags.help, true);
  assert.equal(parseArgs(['-h']).flags.help, true);
  assert.equal(parseArgs(['--version']).flags.version, true);
  assert.equal(parseArgs(['-v']).flags.version, true);
});

test('parseArgs：拼错的选项报错而不是静默忽略', () => {
  assert.throws(() => parseArgs(['--prot', '3010']), /不认识的选项：--prot/);
  assert.throws(() => parseArgs(['extra']), /不认识的选项：extra/);
});

test('parseArgs：值选项漏写值时报错，不会把下一个选项当值', () => {
  assert.throws(() => parseArgs(['--port']), /--port 需要接一个值/);
  assert.throws(() => parseArgs(['--port', '--db', 'x']), /--port 需要接一个值/);
  // 空串与纯空白同样是漏写：`--db ''` 会悄悄解析成当前目录。
  assert.throws(() => parseArgs(['--host', '']), /--host 需要接一个值/);
  assert.throws(() => parseArgs(['--port=']), /--port 需要接一个值/);
  assert.throws(() => parseArgs(['--db', '   ']), /--db 需要接一个值/);
});

test('parsePort：只接受 1-65535 的整数', () => {
  assert.equal(parsePort('1', '--port'), 1);
  assert.equal(parsePort('65535', '--port'), 65535);
  for (const bad of ['0', '-1', '65536', 'abc', '3001.5', '']) {
    assert.throws(() => parsePort(bad, '--port'), /不是合法端口/);
  }
});

test('defaultDbPath：落在用户目录下，与包的安装位置无关', () => {
  assert.equal(defaultDbPath(env()), path.join('/home/tester', '.mailuo', 'kanban.db'));
  // Windows 没有 HOME，退到 USERPROFILE。
  assert.equal(defaultDbPath({ USERPROFILE: 'C:\\Users\\tester' }), path.join('C:\\Users\\tester', '.mailuo', 'kanban.db'));
});

test('resolveConfig：全默认', () => {
  const config = resolveConfig([], env());
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3001);
  assert.equal(config.portIsDefault, true);
  assert.equal(config.dbPath, path.join('/home/tester', '.mailuo', 'kanban.db'));
  assert.equal(config.open, true);
});

test('resolveConfig：命令行压过环境变量', () => {
  const config = resolveConfig(
    ['--port', '3010', '--host', '0.0.0.0', '--db', 'tmp/tasks.db'],
    env({ PORT: '3002', HOST: '10.0.0.9', KANBAN_DB_PATH: '/data/other.db' }),
  );
  assert.equal(config.port, 3010);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.dbPath, path.resolve('tmp/tasks.db'));
  assert.equal(config.portIsDefault, false);
});

test('resolveConfig：环境变量压过默认值', () => {
  const config = resolveConfig([], env({ PORT: '3002', KANBAN_DB_PATH: '/data/other.db', HOST_ALLOW: 'a.local,b.local' }));
  assert.equal(config.port, 3002);
  assert.equal(config.dbPath, '/data/other.db');
  assert.equal(config.hostAllow, 'a.local,b.local');
  // PORT 来自环境变量时视为用户指定，不再自动换端口。
  assert.equal(config.portIsDefault, false);
});

test('resolveConfig：相对数据库路径按当前工作目录解析', () => {
  assert.equal(resolveConfig(['--db', './tasks.db'], env()).dbPath, path.resolve('./tasks.db'));
});

test('resolveConfig：MAILUO_NO_OPEN 关掉自动打开，--open 又能打开', () => {
  assert.equal(resolveConfig([], env({ MAILUO_NO_OPEN: '1' })).open, false);
  assert.equal(resolveConfig(['--open'], env({ MAILUO_NO_OPEN: '1' })).open, true);
  // 只认 '1'：设成 '0' 或 'false' 不算关。
  assert.equal(resolveConfig([], env({ MAILUO_NO_OPEN: '0' })).open, true);
});

test('resolveConfig：非法端口、空监听地址、空数据库路径直接报错', () => {
  assert.throws(() => resolveConfig(['--port', '70000'], env()), /--port 不是合法端口/);
  assert.throws(() => resolveConfig([], env({ PORT: 'x' })), /PORT 不是合法端口/);
  // 环境变量里的空值是「设了但没填」，不能悄悄回落默认值（数据库那条回落成当前目录更糟）。
  assert.throws(() => resolveConfig([], env({ HOST: '  ' })), /监听地址不能为空/);
  assert.throws(() => resolveConfig([], env({ KANBAN_DB_PATH: '' })), /数据库路径不能为空/);
});

test('resolveConfig：版本提示默认开，MAILUO_NO_UPDATE_CHECK=1 才关；registry 三级回落', () => {
  assert.equal(resolveConfig([], env()).updateCheck, true);
  assert.equal(resolveConfig([], env({ MAILUO_NO_UPDATE_CHECK: '1' })).updateCheck, false);
  // 只认 '1'：设成 '0' 或 'false' 不算关（与 MAILUO_NO_OPEN 同一口径）。
  assert.equal(resolveConfig([], env({ MAILUO_NO_UPDATE_CHECK: '0' })).updateCheck, true);

  assert.equal(resolveConfig([], env()).registry, 'https://registry.npmjs.org');
  // 用镜像或私有源的用户只配过 npm，这里跟随它，不必再配一遍；两边的变量都去空白。
  assert.equal(
    resolveConfig([], env({ npm_config_registry: '  https://mirror.example/  ' })).registry,
    'https://mirror.example/',
  );
  // 自己的变量优先于 npm 的配置；空串视为没设，回落而不是当成一个空地址。
  assert.equal(
    resolveConfig(
      [],
      env({ npm_config_registry: 'https://mirror.example/', MAILUO_REGISTRY: 'https://own.example' }),
    ).registry,
    'https://own.example',
  );
  assert.equal(resolveConfig([], env({ MAILUO_REGISTRY: '  ' })).registry, 'https://registry.npmjs.org');
  // 构造不出 URL 的地址当没设：否则每次启动都会在 fetch 里抛错被吞掉，表现为功能永远没反应。
  assert.equal(resolveConfig([], env({ npm_config_registry: 'not a url' })).registry, 'https://registry.npmjs.org');
  assert.equal(resolveConfig([], env({ MAILUO_REGISTRY: 'not a url' })).registry, 'https://registry.npmjs.org');
});

test('parseVersion 与 isNewerVersion：只认三段数字，只有严格更新才算新', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion(' v0.10.2 '), [0, 10, 2]);
  assert.deepEqual(parseVersion('0.2.0-beta.1'), [0, 2, 0]);
  assert.equal(parseVersion('next'), null);
  assert.equal(parseVersion(undefined), null);
  // 整串匹配：换行、ANSI 转义、多余的数字段都让整串作废。前缀匹配会放过它们，而打印时
  // 回显的是外部串，等于让被污染的 registry 往终端里写控制字符。
  assert.equal(parseVersion('9.9.9\r\n发现新版本 99.0.0（当前 0.0.1）：npm i -g evil@latest'), null);
  assert.equal(parseVersion('9.9.9\u001b[2K'), null);
  assert.equal(parseVersion('9.9.9.9'), null);
  assert.equal(parseVersion('9.9'), null);

  assert.equal(isNewerVersion('0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true);
  assert.equal(isNewerVersion('1.0.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(isNewerVersion('0.0.9', '0.1.0'), false);
  // 预发布后缀不参与比较：0.2.0-beta.1 与 0.2.0 算同一个版本，不提示升级。
  assert.equal(isNewerVersion('0.2.0-beta.1', '0.2.0'), false);
  // 解析不出来时一律「不算新」：宁可不提示，也不能凭半截比较给出错的升级建议。
  assert.equal(isNewerVersion('latest', '0.1.0'), false);
  assert.equal(isNewerVersion('9.9.9\r\nnpm i -g evil@latest', '0.1.0'), false);
  assert.equal(isNewerVersion('9.9.9', 'not-a-version'), false);
});

test('fetchLatestVersion：本地 registry 上的 latest 决定是否提示，各种失败都静默', async (t) => {
  const newer = nextMajorVersion();
  const cases = [
    { label: '有新版本', handler: respondJson(200, { version: newer }), expected: newer },
    // 回显的是本地拼出的三段数字，不是 registry 的原始串：后缀被丢掉。
    { label: '带预发布后缀的新版本', handler: respondJson(200, { version: `${newer}-rc.1` }), expected: newer },
    { label: '同版本', handler: respondJson(200, { version: PACKAGE_JSON.version }), expected: null },
    { label: '版本更旧', handler: respondJson(200, { version: '0.0.1' }), expected: null },
    { label: '包还没发布（404）', handler: respondJson(404, { error: 'Not found' }), expected: null },
    {
      label: '版本号里夹带换行与伪造的升级命令',
      handler: respondJson(200, { version: `${newer}\r\n发现新版本 99.0.0（当前 0.0.1）：npm i -g evil@latest` }),
      expected: null,
    },
    {
      label: '版本号里夹带 ANSI 擦行符',
      handler: respondJson(200, { version: `${newer}\u001b[2K` }),
      expected: null,
    },
    {
      label: '响应不是 JSON',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>not json</html>');
      },
      expected: null,
    },
  ];

  for (const item of cases) {
    const registry = await startRegistry(item.handler);
    t.after(() => registry.close());
    const latest = await fetchLatestVersion({
      registry: registry.url,
      name: PACKAGE_JSON.name,
      currentVersion: PACKAGE_JSON.version,
    });
    assert.equal(latest, item.expected, item.label);
  }
});

test('fetchLatestVersion：registry 卡住时到点就放弃，不抛异常', async (t) => {
  // 只接受连接、永不回应，模拟 registry 无响应。
  const registry = await startRegistry(() => {});
  t.after(() => registry.close());

  const started = Date.now();
  const latest = await fetchLatestVersion({
    registry: registry.url,
    name: PACKAGE_JSON.name,
    currentVersion: PACKAGE_JSON.version,
    timeoutMs: 100,
  });
  assert.equal(latest, null);
  assert.ok(Date.now() - started < 1000, '应在上限附近就返回，而不是把默认的 1.5 秒耗完');
});

test('fetchLatestVersion：registry 不是合法地址时也返回 null', async () => {
  const latest = await fetchLatestVersion({
    registry: '不是地址',
    name: PACKAGE_JSON.name,
    currentVersion: PACKAGE_JSON.version,
  });
  assert.equal(latest, null);
});

test('reportUpdate：查到新版本打印一行升级命令，其余情况一个字都不打', async (t) => {
  const newer = nextMajorVersion();
  const registry = await startRegistry(respondJson(200, { version: newer }));
  t.after(() => registry.close());

  const spoken = captureLog();
  try {
    await reportUpdate(registry.url);
  } finally {
    spoken.restore();
  }
  assert.deepEqual(spoken.lines, [
    `发现新版本 ${newer}（当前 ${PACKAGE_JSON.version}）：npm i -g ${PACKAGE_JSON.name}@latest`,
  ]);

  // 没有新版本（这里用 404）时不打印：失败的版本提示不该在启动输出里留痕。
  const missing = await startRegistry(respondJson(404, {}));
  t.after(() => missing.close());
  const quiet = captureLog();
  try {
    await reportUpdate(missing.url);
  } finally {
    quiet.restore();
  }
  assert.deepEqual(quiet.lines, []);
});

test('formatUrl：IPv6 加方括号，重复的方括号不会叠', () => {
  assert.equal(formatUrl('127.0.0.1', 3001), 'http://127.0.0.1:3001');
  assert.equal(formatUrl('::1', 3001), 'http://[::1]:3001');
  assert.equal(formatUrl('[::1]', 3001), 'http://[::1]:3001');
  assert.equal(formatUrl('fd7a:115c::1', 3001), 'http://[fd7a:115c::1]:3001');
});

test('browserHost：通配监听时浏览器访问回环地址', () => {
  assert.equal(browserHost('0.0.0.0'), '127.0.0.1');
  assert.equal(browserHost('::'), '127.0.0.1');
  assert.equal(browserHost('127.0.0.1'), '127.0.0.1');
  assert.equal(browserHost('192.168.1.5'), '192.168.1.5');
  assert.equal(browserHost('::1'), '::1');
});

test('isDirectRun：直接执行、被 import、符号链接三种情况', () => {
  const selfUrl = new URL('./mailuo.mjs', import.meta.url).href;
  assert.equal(isDirectRun(BIN_PATH, selfUrl), true);
  // 被 import（测试正在这么做）时 argv[1] 是测试文件，不是本文件。
  assert.equal(isDirectRun(fileURLToPath(import.meta.url), selfUrl), false);
  assert.equal(isDirectRun(undefined, selfUrl), false);
  assert.equal(isDirectRun('/nonexistent/mailuo.mjs', selfUrl), false);

  // 符号链接：npm / pnpm 全局安装后的 bin 就是这个形状，argv[1] 是链接路径而 import.meta.url
  // 是真实路径。第一版判定在这里恒假，命令静默不执行。
  const root = mkdtempSync(path.join(tmpdir(), 'mailuo-directrun-'));
  try {
    const link = path.join(root, 'mailuo');
    symlinkSync(BIN_PATH, link);
    assert.equal(isDirectRun(link, selfUrl), true, '符号链接调用必须被认成直接执行');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probePort 与 findFreePort：占用中的端口会被跳过', async () => {
  const { port, release } = await occupyPort();
  try {
    assert.equal(await probePort(port, '127.0.0.1'), true, '监听中的端口应判定为被占用');
    const free = await findFreePort(port, '127.0.0.1');
    assert.notEqual(free, port);
    assert.equal(await probePort(free, '127.0.0.1'), false, '扫出来的端口应是空的');
  } finally {
    await release();
  }
});

test('main：--help 与 --version 只打印，不起服务，且不被参数错误顶回去', async () => {
  let started = 0;
  const startServer = async () => {
    started += 1;
  };

  assert.equal(await main(['--help'], { env: env(), startServer }), 0);
  assert.equal(await main(['--version'], { env: env(), startServer }), 0);
  // 求助路径不该因为别的参数写错而失败。
  assert.equal(await main(['--help', '--port', 'abc'], { env: env(), startServer }), 0);
  assert.equal(await main(['--help', '--nonsense'], { env: env(), startServer }), 0);
  assert.equal(await main(['--version', '--prot', 'x'], { env: env(), startServer }), 0);
  assert.equal(started, 0);
});

test('main：命令行的端口与数据库路径确实交给启动函数', async () => {
  const received = [];
  const checked = [];
  const startServer = async (config) => {
    received.push(config);
  };
  // 注入版本检查：这条用例不该联网，也不该等 registry。
  const reportUpdate = async (registry) => {
    checked.push(registry);
  };
  await main(['--port', '3010', '--db', './tasks.db', '--no-open'], { env: env(), startServer, reportUpdate });
  assert.equal(received.length, 1);
  assert.equal(received[0].port, 3010);
  assert.equal(received[0].dbPath, path.resolve('./tasks.db'));
  assert.equal(received[0].open, false);
  // 默认查一次，用的是官方源。
  assert.deepEqual(checked, ['https://registry.npmjs.org']);
});

test('main：版本检查跟随开关与 MAILUO_REGISTRY，且排在启动之后', async () => {
  const order = [];
  const checked = [];
  const startServer = async () => {
    order.push('start');
  };
  const reportUpdate = async (registry) => {
    order.push('check');
    checked.push(registry);
  };

  await main(['--port', '3010'], { env: env({ MAILUO_NO_UPDATE_CHECK: '1' }), startServer, reportUpdate });
  assert.deepEqual(checked, [], '关掉后不该查');

  await main(['--port', '3010'], {
    env: env({ MAILUO_REGISTRY: 'https://mirror.example/' }),
    startServer,
    reportUpdate,
  });
  assert.deepEqual(checked, ['https://mirror.example/']);
  // 服务先起来，版本提示最后做。
  assert.deepEqual(order, ['start', 'start', 'check']);
});

test('进程级：符号链接调用 bin 时 --version 正常输出（全局安装的形状）', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'mailuo-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realDir = path.join(root, 'lib', 'mailuo');
  const binDir = path.join(root, 'bin');
  mkdirSync(realDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  symlinkSync(BIN_PATH, path.join(realDir, 'mailuo.mjs'));
  symlinkSync(path.join(realDir, 'mailuo.mjs'), path.join(binDir, 'mailuo'));

  const result = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(binDir, 'mailuo'), '--version'], { encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
  assert.equal(result.code, 0, `退出码应为 0，stderr: ${result.stderr}`);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/, `应打印版本号，实际 stdout: ${JSON.stringify(result.stdout)}`);
});

test('进程级：--help 打印用法后退出 0，不起服务', async () => {
  const result = await runBin(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /脉络（Mailuo）本地服务/);
  assert.match(result.stdout, /--db <路径>/);
  assert.match(result.stdout, /MAILUO_NO_UPDATE_CHECK/);
  assert.equal(result.stderr, '');
});

test('进程级：显式端口被占用时报告 CLI 自己的提示，退出码 1，且不打印启动横幅', async () => {
  const { port, release } = await occupyPort();
  try {
    const result = await runBin([
      '--port',
      String(port),
      '--db',
      path.join(tmpdir(), 'mailuo-eaddr', 'kanban.db'),
      '--no-open',
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`端口 ${port} 已被占用`));
    // 不能把「已启动」横幅打在失败之前。
    assert.doesNotMatch(result.stdout, /脉络已启动/);
  } finally {
    await release();
  }
});

test('进程级：真起服务，监听成功后才打印启动横幅', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailuo-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { port, release } = await occupyPort();
  await release(); // 只是为了拿一个当前空着的端口

  const cli = startCli(['--port', String(port), '--db', path.join(dir, 'kanban.db'), '--no-open']);
  try {
    await cli.waitFor('脉络已启动');
    const output = cli.output();
    const bannerIndex = output.indexOf('脉络已启动');
    const listenIndex = output.indexOf('API 监听');
    assert.ok(listenIndex >= 0, `服务端应报告监听，实际输出：\n${output}`);
    assert.ok(listenIndex < bannerIndex, `监听应早于启动横幅，实际输出：\n${output}`);

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  } finally {
    await cli.stop();
  }
});

test('进程级：启动后查 registry 上的新版本，并在启动横幅之后提示升级命令', async (t) => {
  const newer = nextMajorVersion();
  const registry = await startRegistry(respondJson(200, { version: newer }));
  t.after(() => registry.close());
  const dir = mkdtempSync(path.join(tmpdir(), 'mailuo-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { port, release } = await occupyPort();
  await release(); // 只是为了拿一个当前空着的端口

  // MAILUO_NO_UPDATE_CHECK=0 压过子进程默认的 '1'：只有这条用例真的联网（连的是本地假 registry）。
  const cli = startCli(['--port', String(port), '--db', path.join(dir, 'kanban.db'), '--no-open'], {
    MAILUO_REGISTRY: registry.url,
    MAILUO_NO_UPDATE_CHECK: '0',
  });
  try {
    await cli.waitFor(`发现新版本 ${newer}`);
    const output = cli.output();
    assert.ok(
      output.indexOf('脉络已启动') < output.indexOf('发现新版本'),
      `版本提示应排在启动横幅之后，实际输出：\n${output}`,
    );
  } finally {
    await cli.stop();
  }
});
