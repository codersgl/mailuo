import path from 'node:path';

/**
 * apps/api 目录。src/ 运行时其上一级是 apps/api，dist/ 运行时上一级同样是 apps/api，
 * 所以开发与构建后 migrations/ 都能被找到。
 */
const apiRoot = path.resolve(import.meta.dirname, '..');

/** 仓库根目录，用于定位 data/ 下的 SQLite 文件。 */
export const repoRoot = path.resolve(apiRoot, '..', '..');

export interface Config {
  port: number;
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
 * 从环境变量读取配置，全部有默认值，直接 `pnpm dev:api` 即可跑起来。
 * 测试通过传参覆盖，避免依赖真实进程环境。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 不是合法端口: ${env.PORT}`);
  }
  return {
    port,
    dbPath: env.KANBAN_DB_PATH ?? path.join(repoRoot, 'data', 'kanban.db'),
    migrationsDir: path.join(apiRoot, 'migrations'),
  };
}
