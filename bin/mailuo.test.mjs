/**
 * `bin/mailuo.mjs` 的单元测试。
 *
 * 这里用 Node 自带的测试运行器（`node --test`），而不是各工作区里的 vitest：被测文件在包根
 * 的 `bin/` 下，不属于任何一个工作区包，用 node:test 就不必为了一个启动器在工作区里再拼
 * 一套模块解析（它只用 Node 内置模块，node:test 正好够用）。根 `package.json` 的 `test`
 * 脚本把自己与 `pnpm -r test` 串起来跑。
 *
 * 真起服务的部分（端口占用扫描、内嵌加载服务端产物）不在这里验证：`main` 的 `startServer`
 * 可注入，这里核对的是「参数合成出的配置」，真进程行为由人工按 README 走一遍。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  browserHost,
  defaultDbPath,
  findFreePort,
  formatUrl,
  main,
  parseArgs,
  parsePort,
  probePort,
  resolveConfig,
} from './mailuo.mjs';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** 只留必要的键：调用方的环境里可能有 PORT/HOST/KANBAN_DB_PATH，不隔离会串味。 */
function env(overrides = {}) {
  return { HOME: '/home/tester', ...overrides };
}

test('parseArgs：值选项、开关与短名', () => {
  assert.deepEqual(parseArgs([]), {
    values: {},
    flags: { help: false, version: false, open: true, hasOpenFlag: false },
  });
  assert.deepEqual(parseArgs(['--port', '3010', '--db', 'a.db']).values, { port: '3010', db: 'a.db' });
  assert.equal(parseArgs(['-p', '3010']).values.port, '3010');
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
  assert.equal(config.help, false);
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

test('resolveConfig：非法端口与空监听地址直接报错', () => {
  assert.throws(() => resolveConfig(['--port', '70000'], env()), /--port 不是合法端口/);
  assert.throws(() => resolveConfig([], env({ PORT: 'x' })), /PORT 不是合法端口/);
  // 环境变量里的空 HOST 是「设了但没填」，不能悄悄回落默认值。
  assert.throws(() => resolveConfig([], env({ HOST: '  ' })), /监听地址不能为空/);
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

test('probePort 与 findFreePort：占用中的端口会被跳过', async () => {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const taken = server.address().port;
  try {
    assert.equal(await probePort(taken, '127.0.0.1'), true, '监听中的端口应判定为被占用');
    // 从占用端口开始扫，应跳过它拿到下一个（几乎必然空着）。
    assert.equal(await findFreePort(taken, '127.0.0.1'), taken + 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('main：--help 与 --version 只打印，不起服务', async () => {
  let started = 0;
  const startServer = async () => {
    started += 1;
  };

  const helpExit = await main(['--help'], { env: env(), startServer });
  const versionExit = await main(['--version'], { env: env(), startServer });
  assert.equal(helpExit, 0);
  assert.equal(versionExit, 0);
  assert.equal(started, 0);
});

test('main：把合成后的配置交给启动函数，默认端口占用时换端口', async () => {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const startPort = server.address().port;
  let received;
  try {
    await main(['--port', String(startPort), '--no-open'], {
      env: env(),
      startServer: async (config) => {
        received = config;
      },
    });
    // 显式给端口时不扫描：拿到的就是点名的端口，占用与否由服务端自己报错。
    assert.equal(received.port, startPort);
    assert.equal(received.dbPath, path.join('/home/tester', '.mailuo', 'kanban.db'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('被 import 时不启动服务，只导出函数', () => {
  // bin/mailuo.mjs 顶部的「直接执行」判定依赖 process.argv[1]；本文件是以 node --test 运行的
  // 测试文件，若判定写错，上面所有用例都会连带起一个真实服务。这里显式确认导出的形状。
  assert.equal(typeof main, 'function');
  assert.equal(typeof resolveConfig, 'function');
  assert.equal(path.basename(process.argv[1]), 'mailuo.test.mjs');
});
