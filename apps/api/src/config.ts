import path from 'node:path';
import { DEFAULT_HOST, parseHostAllow } from './domain/net.js';

/**
 * apps/api 目录。src/ 运行时其上一级是 apps/api，dist/ 运行时上一级同样是 apps/api，
 * 所以开发与构建后 migrations/ 都能被找到。
 */
const apiRoot = path.resolve(import.meta.dirname, '..');

/** 仓库根目录，用于定位 data/ 下的 SQLite 文件。 */
export const repoRoot = path.resolve(apiRoot, '..', '..');

/** 本机配置文件：仓库根目录的 .env，不入版本库（见 .gitignore）。 */
export const envFilePath = path.join(repoRoot, '.env');

export interface Config {
  port: number;
  /**
   * 监听地址。默认 `127.0.0.1`，即只服务本机；想跨设备访问必须显式设 `HOST`。
   * `app.ts` 的 Host 白名单与启动日志都用它（见 docs/decisions.md D55）。
   */
  host: string;
  /**
   * 额外放行的 Host 主机名（`HOST_ALLOW`，逗号分隔）。用机器名或 MagicDNS 名字访问时才需要，
   * 用 IP 访问由启动方枚举网卡地址自动覆盖。
   */
  hostAllow: string[];
  /** SQLite 文件路径。 */
  dbPath: string;
  /** 迁移文件目录。 */
  migrationsDir: string;
}

/**
 * 默认端口。开发机上 3000 常被其他服务占用，这里避开它。
 * 注意 docs/spec.md 的开发约定里写的是 3000，改端口后需要用户同步更新规范。
 */
export const DEFAULT_PORT = 3001;

/**
 * 把根目录 .env 里的键值读进 process.env。
 *
 * 为什么需要它：开发时端口要同时告诉 apps/api 和 apps/web（Vite 的代理目标）。两边都靠
 * `PORT=3003 pnpm dev:xxx` 前缀传时，漏掉一个就会出现「后端正常、前端 404」这种难查的状态
 * ——前端的代理还指着旧端口。写进 .env 后两边自动一致（见 docs/decisions.md D41）。
 *
 * Node 的 process.loadEnvFile 不覆盖已存在的环境变量，所以命令行的 `PORT=3003` 仍然优先于文件。
 * 文件不存在是正常情况（新克隆的仓库没有 .env），静默跳过；其它读取错误照常抛出。
 */
export function loadEnvFileIfPresent(filePath: string = envFilePath): void {
  try {
    process.loadEnvFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * 从环境变量读取配置，全部有默认值，直接 `pnpm dev:api` 即可跑起来。
 * 测试通过传参覆盖，避免依赖真实进程环境。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 不是合法端口: ${env.PORT}`);
  }
  // 空串是「设了但没填」，不能当成默认值悄悄继续：那种情况下用户以为自己放开了或收紧了监听，
  // 实际拿到的是另一个地址。Node 自己对非法地址会抛，不在这里重复校验。
  const host = (env.HOST ?? DEFAULT_HOST).trim();
  if (host === '') {
    throw new Error('HOST 不能为空；只服务本机请删掉这一项（默认 127.0.0.1）');
  }
  return {
    port,
    host,
    hostAllow: parseHostAllow(env.HOST_ALLOW),
    dbPath: env.KANBAN_DB_PATH ?? path.join(repoRoot, 'data', 'kanban.db'),
    migrationsDir: path.join(apiRoot, 'migrations'),
  };
}
