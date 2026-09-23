#!/usr/bin/env node

/**
 * 脉络的本地服务入口（`npx mailuo` / `npm i -g mailuo`）。
 *
 * 为什么是一个独立的 JS 启动器，而不是直接跑 `node apps/api/dist/index.js`：
 *
 * 1. 服务端入口（`apps/api/src/index.ts`）读的是仓库布局的默认值——数据库落在仓库根的
 *    `data/`、前端产物找 `apps/web/dist`、本机配置读仓库根的 `.env`。这些默认值对「从源码
 *    跑」是对的，但作为命令行工具，数据库应该落在用户目录下（全局安装的包目录是只读的，
 *    升级会连库一起换掉）。
 * 2. 命令行参数（`--port` 等）需要有一条唯一的优先级规则。放在这里翻译成环境变量，服务端
 *    自己完全不用知道「是谁传的」。
 *
 * 所以职责就一条：把命令行参数与环境变量合成一份确定的配置，起服务、开浏览器。
 *
 * 它只用 Node 内置模块，没有运行时依赖：`npx` 首次执行不必先装一堆包。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 本包根目录。bin/ 的上一级就是包根，源码运行与全局安装都一样。 */
const packageRoot = path.resolve(import.meta.dirname, '..');

/** 默认监听地址：只服务本机。跨设备访问要显式 `--host`。 */
const DEFAULT_HOST = '127.0.0.1';

/** 与服务端 `apps/api/src/config.ts` 的 DEFAULT_PORT 保持一致。 */
const DEFAULT_PORT = 3001;

/** 相对包根定位服务端产物：源码运行与全局安装的布局相同。 */
const SERVER_ENTRY_RELATIVE = path.join('apps', 'api', 'dist', 'index.js');

/** 端口缺省时，启动扫描的候选数（被占用就往后试一个）。 */
const PORT_SCAN_LIMIT = 20;

/** 端口探测的超时：连不上就说明这个端口空着。 */
const PORT_PROBE_TIMEOUT_MS = 300;

const HELP = `脉络（Mailuo）本地服务

用法
  npx mailuo [选项]
  npm i -g mailuo && mailuo [选项]

选项
  -p, --port <端口>   监听端口，默认 ${DEFAULT_PORT}；被占用时自动往后试 ${PORT_SCAN_LIMIT} 个
      --host <地址>   监听地址，默认 ${DEFAULT_HOST}（只服务本机）
      --db <路径>     SQLite 文件路径，默认 ~/.mailuo/kanban.db
      --open          强制打开浏览器（压过 MAILUO_NO_OPEN=1）
      --no-open       不自动打开浏览器
  -h, --help          显示本帮助
  -v, --version       显示版本号

环境变量
  PORT             同 --port
  HOST             同 --host，例如 0.0.0.0 供同网段访问（接口没有鉴权，请自行确认网络可信）
  HOST_ALLOW       额外放行的 Host 主机名，逗号分隔
  KANBAN_DB_PATH   同 --db
  MAILUO_NO_OPEN   设为 1 时不自动打开浏览器

优先级：命令行 > 环境变量 > 默认值。`;

/**
 * 解析命令行参数。
 *
 * 未知参数直接报错，不静默忽略：`mailuo --prot 3010` 那种拼错如果被吞掉，用户看到的是
 * 「服务起在 3001 上」，而不是「你的参数不认识」。
 *
 * @param {string[]} argv 不含 node 与脚本路径的参数列表
 */
export function parseArgs(argv) {
  const values = {};
  // `hasOpenFlag` 与 `open` 分开：只有真的写了 `--open` / `--no-open` 时才压过 MAILUO_NO_OPEN，
  // 没写时那个环境变量才是用户的意图。
  const flags = { help: false, version: false, open: true, hasOpenFlag: false };
  // 需要接一个值的选项，写在一处，便于与下面的取值逻辑逐字对应。
  const valueOptions = { '-p': 'port', '--port': 'port', '--host': 'host', '--db': 'db' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      flags.version = true;
      continue;
    }
    if (arg === '--no-open') {
      flags.open = false;
      flags.hasOpenFlag = true;
      continue;
    }
    if (arg === '--open') {
      flags.open = true;
      flags.hasOpenFlag = true;
      continue;
    }
    const key = valueOptions[arg];
    if (key !== undefined) {
      const value = argv[index + 1];
      // 值的首字符是 '-' 时视为漏写值（例如 `--port --db x`），避免把下一个选项名当成端口；
      // 空串同样是漏写（`--db ''` 会悄悄解析成当前目录）。
      if (value === undefined || value.trim() === '' || value.startsWith('-')) {
        throw new Error(`选项 ${arg} 需要接一个值，例如 ${arg} ${key === 'host' ? DEFAULT_HOST : '3001'}`);
      }
      values[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`不认识的选项：${arg}（用 --help 看用法）`);
  }

  return { values, flags };
}

/** 端口必须是 1..65535 的整数。 */
export function parsePort(raw, source) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} 不是合法端口：${raw}（应为 1-65535 的整数）`);
  }
  return port;
}

/**
 * 本机默认数据库：`~/.mailuo/kanban.db`。
 *
 * 为什么不沿用服务端的 `data/kanban.db`：那个默认值是相对包目录算的，全局安装后落在
 * `node_modules/mailuo/data/` 里——升级或重装包就会换掉那份数据，而且包目录通常是只读的。
 * 用户目录下的固定路径与包的安装位置、版本都无关。
 */
export function defaultDbPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return path.join(home, '.mailuo', 'kanban.db');
}

/** IPv6 字面量写进 URL 要加方括号，`::1:3001` 会被当成端口歧义。 */
export function formatUrl(host, port) {
  const withoutBrackets = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return `http://${withoutBrackets.includes(':') ? `[${withoutBrackets}]` : withoutBrackets}:${port}`;
}

/**
 * 浏览器该访问哪个地址。
 *
 * 监听 `0.0.0.0` / `::`（所有网卡）时不能把通配地址当 URL：`http://0.0.0.0:3001` 在多数浏览器里
 * 打不开，那里没有服务。本机自己访问就走回环。
 */
export function browserHost(host) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare === '0.0.0.0' || bare === '::' ? DEFAULT_HOST : bare;
}

/**
 * 合成启动配置。优先级：命令行 > 环境变量 > 默认值。
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveConfig(argv, env = process.env) {
  const { values, flags } = parseArgs(argv);

  const port =
    values.port !== undefined
      ? parsePort(values.port, '--port')
      : env.PORT !== undefined
        ? parsePort(env.PORT, 'PORT')
        : DEFAULT_PORT;

  const host = (values.host ?? env.HOST ?? DEFAULT_HOST).trim();
  if (host === '') {
    // 空串是「设了但没填」，当成默认值会悄悄换成另一个监听地址（服务端对 HOST 也是这个口径）。
    throw new Error('监听地址不能为空；只服务本机请去掉 --host（默认 127.0.0.1）');
  }

  const dbRaw = values.db ?? env.KANBAN_DB_PATH ?? defaultDbPath(env);

  return {
    host,
    port,
    // 端口来自默认值时可以在被占用后自动往后找；显式指定的端口不做替换。
    portIsDefault: values.port === undefined && env.PORT === undefined,
    // 统一成绝对路径：服务端会把它当成当前工作目录的相对路径解释，而用户期望的是
    // 「我在哪儿敲的命令，库就在哪儿」。
    dbPath: path.resolve(dbRaw),
    open: flags.hasOpenFlag ? flags.open : env.MAILUO_NO_OPEN !== '1',
    hostAllow: env.HOST_ALLOW ?? '',
    help: flags.help,
    version: flags.version,
    cliVersion: findVersion(),
  };
}

/** 读本包的版本号。读不到时返回 null，由调用方决定怎么降级。 */
let cachedVersion;
function findVersion() {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    cachedVersion = typeof packageJson.version === 'string' ? packageJson.version : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/**
 * 探测端口是否空着：连得上说明被占用。
 *
 * 只是「尽力而为」——`--port` 显式指定时不做探测（用户点名要那个端口，失败就让他看见失败），
 * 只有默认端口才自动往后找。
 */
export function probePort(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (taken) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 默认端口被占用时，从它开始往后找第一个空位。 */
export async function findFreePort(startPort, host) {
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const port = startPort + offset;
    if (port > 65535) {
      break;
    }
    if (!(await probePort(port, host))) {
      return port;
    }
  }
  throw new Error(`从 ${startPort} 起的 ${PORT_SCAN_LIMIT} 个端口都被占用了，请用 --port 指定一个空闲端口`);
}

/** 按平台打开浏览器，失败不抛：打不开只是少一步便利，服务该继续跑。 */
function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.warn(`打不开浏览器，请手动访问 ${url}`);
  });
  child.unref();
}

/** 起服务：在进程内加载服务端产物，与服务端入口共用同一份 Host 白名单与静态托管逻辑。 */
async function startServer(config) {
  const serverEntry = path.join(packageRoot, SERVER_ENTRY_RELATIVE);
  if (!existsSync(serverEntry)) {
    throw new Error(`找不到服务端产物：${serverEntry}\n请先构建（见 README 的「从源码运行」）。`);
  }

  // 服务端入口先读自己目录下的 .env、再读这份环境变量；进程环境优先，所以命令行说了算。
  process.env.PORT = String(config.port);
  process.env.HOST = config.host;
  process.env.KANBAN_DB_PATH = config.dbPath;
  if (config.hostAllow !== '') {
    process.env.HOST_ALLOW = config.hostAllow;
  }

  await mkdir(path.dirname(config.dbPath), { recursive: true });
  await import(pathToFileURL(serverEntry).href);
}

/**
 * 命令行主流程。
 *
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, startServer?: (config: object) => Promise<void> }} [options]
 *   `startServer` 可注入，便于在不真的起服务的前提下核对参数合成的结果。
 */
export async function main(argv, options = {}) {
  const env = options.env ?? process.env;
  const start = options.startServer ?? startServer;
  const config = resolveConfig(argv, env);

  if (config.help) {
    console.log(HELP);
    return 0;
  }
  if (config.version) {
    if (config.cliVersion === null) {
      throw new Error('读不到包版本号，请检查安装是否完整');
    }
    console.log(config.cliVersion);
    return 0;
  }

  // 只对默认端口做扫描：显式给了 --port 就是用户的决定，被占用应原样报错。
  if (config.portIsDefault) {
    const free = await findFreePort(DEFAULT_PORT, config.host);
    if (free !== DEFAULT_PORT) {
      console.log(`端口 ${DEFAULT_PORT} 被占用，改用 ${free}（用 --port 可指定端口）`);
      config.port = free;
    }
  }

  await start(config);

  const url = formatUrl(browserHost(config.host), config.port);
  console.log(`脉络已启动：${url}（数据库 ${config.dbPath}）`);
  console.log('按 Ctrl+C 退出。');
  if (config.open) {
    openBrowser(url);
  }
  return 0;
}

// 只有被当作可执行文件直接跑时才启动；被 import（例如单测）时只导出上面的纯函数。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
