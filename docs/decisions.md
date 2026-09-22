# 决策记录

记录影响后续实现的决策，只追加。需求与规范见 `docs/intend.md`、`docs/spec.md`，两者由用户维护。

## D1 用 pnpm workspace 管理多应用（2025-09-22）

规范已定下 `apps/web` 与 `apps/api` 两个应用，需要一个工作区把两者的依赖和脚本组织起来。选 pnpm：单一 lockfile、依赖硬链接节省磁盘、`pnpm --filter` 可直接跑单个应用。

`apps/api` 需要编译原生模块 better-sqlite3，pnpm 默认拦截安装脚本，因此 `pnpm-workspace.yaml` 里用 `onlyBuiltDependencies` 放行它，否则装完运行时报「找不到绑定文件」。

## D2 worktree 放在仓库内 `.worktrees/`（2025-09-22）

规范要求通过 worktree 推进、审阅后才合并主干。常见做法是把 worktree 放在仓库同级目录，但当前开发环境只允许写入仓库目录，因此放在 `.worktrees/<分支名>`，并在 `.gitignore` 中排除。

代价：worktree 内要各自 `pnpm install` 一份 `node_modules`。个人项目规模下可接受，换来的是每个 worktree 完全隔离。

## D3 迁移按编号 SQL 文件 + schema_migrations（2025-09-22）

规范要求手写编号 SQL 文件、启动时按序执行、执行记录落在 `schema_migrations`。补充两条实现约定：

- 每个迁移文件在**单个事务**内执行，失败整份回滚且不写入记录，下次启动重试。所以迁移文件内不能自己写 `BEGIN`/`COMMIT`（嵌套事务会直接报错）。
- 文件名必须是 `<数字>_<名字>.sql`。编号重复或缺前缀在启动时报错，避免靠文件名字典序决定执行顺序。

只向前迁移，不实现回滚。个人项目回滚迁移的复杂度高于它的收益，需要回退时直接改数据或删掉 `data/kanban.db` 重来。

## D4 数据库 snake_case，API camelCase（2025-09-22）

SQL 列名保持 `parent_id`、`archived_at` 这类写法，与规范里的建表语句一致；HTTP 响应统一转成 `parentId`、`archivedAt`，前端不需要在两种风格间切换。转换只发生在仓储层（`src/repositories/`），路由层直接返回仓储的返回结构。

## D5 完成列 id 固定为 `done`（2025-09-22）

进度计数要判断「子任务是否处于完成列」。规范里三列在迁移中写死，但没有指定 id。约定完成列 id 为 `done`，常量放在 `src/domain/columns.ts`，迁移 001 写入同一 id。改动必须同时改两处。
