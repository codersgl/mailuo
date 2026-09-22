# 决策记录

记录影响后续实现的决策，只追加。需求与规范见 `docs/intend.md`、`docs/spec.md`，两者由用户维护。

## D1 用 pnpm workspace 管理多应用（2025-09-22）

规范已定下 `apps/web` 与 `apps/api` 两个应用，需要一个工作区把两者的依赖和脚本组织起来。选 pnpm：单一 lockfile、依赖硬链接节省磁盘、`pnpm --filter` 可直接跑单个应用。

`apps/api` 需要准备 better-sqlite3 的原生产物，pnpm 默认拦截依赖的安装脚本，因此在 `pnpm-workspace.yaml` 里用 `allowBuilds` 映射放行 `better-sqlite3` 与 `esbuild`。

注意字段名：pnpm 11 用的是 `allowBuilds`（包名到布尔值的映射）。旧写法 `onlyBuiltDependencies` 会被 pnpm 自动改写进 `allowBuilds`，但值写成占位符 `set this to true or false`，装完依赖仍然不会执行安装脚本。放行后如果依赖已经装好，需要 `pnpm rebuild <包名>` 才会补跑脚本。

## D2 worktree 放在仓库内 `.worktrees/`（2025-09-22）

规范要求通过 worktree 推进、审阅后才合并主干。常见做法是把 worktree 放在仓库同级目录，但当前开发环境只允许写入仓库目录，因此放在 `.worktrees/<分支名>`，并在 `.gitignore` 中排除。

代价：worktree 内要各自 `pnpm install` 一份 `node_modules`。个人项目规模下可接受，换来的是每个 worktree 完全隔离。

## D3 迁移按编号 SQL 文件 + schema_migrations（2025-09-22）

规范要求手写编号 SQL 文件、启动时按序执行、执行记录落在 `schema_migrations`。补充两条实现约定：

- 每个迁移文件在**单个事务**内执行，失败整份回滚且不写入记录，下次启动重试。所以迁移文件内不能自己写 `BEGIN`/`COMMIT`（嵌套事务会直接报错）。
- 文件名必须是 `<数字>_<名字>.sql`。编号重复或缺前缀在启动时报错，避免靠文件名字典序决定执行顺序。

只向前迁移，不实现回滚。个人项目回滚迁移的复杂度高于它的收益，需要回退时直接改数据或删掉 `data/kanban.db` 重来。

已知限制：迁移在启动时执行，没有跨进程互斥。规范确定生产只跑一个进程，所以不做处理；但如果两个进程同时指向同一个不存在的数据库文件，后启动的那个会因「表已存在」而崩溃退出，重启即恢复。将来若真出现多进程启动，把「读取已应用列表 + 执行迁移」整体放进一个 `BEGIN IMMEDIATE` 事务即可。

## D4 数据库 snake_case，API camelCase（2025-09-22）

SQL 列名保持 `parent_id`、`archived_at` 这类写法，与规范里的建表语句一致；HTTP 响应统一转成 `parentId`、`archivedAt`，前端不需要在两种风格间切换。转换只发生在仓储层（`src/repositories/`），路由层直接返回仓储的返回结构。

## D5 完成列 id 固定为 `done`（2025-09-22）

进度计数要判断「子任务是否处于完成列」。规范里三列在迁移中写死，但没有指定 id。约定完成列 id 为 `done`，常量放在 `src/domain/columns.ts`，迁移 001 写入同一 id。改动必须同时改两处。

## D6 归档过滤参数推迟到归档功能那一步（2025-09-22）

规范的看板查询里有「显示已归档时去掉 `archived_at IS NULL`」这一分支，但归档开关属于第一批后半段的功能。本步 `readBoard(db, parentId)` 固定只返回未归档任务，等做归档 UI 时再加 `includeArchived` 选项并同步接入路由，不提前留参数。

## D7 删除任务的级联策略待定（2025-09-22）

规范要求 `DELETE /api/tasks/:id` 级联删除后代及相关依赖记录。当前 `tasks.parent_id` 没有 `ON DELETE CASCADE`，而外键约束已生效，所以直接 `DELETE` 一个有子任务的任务会抛 `FOREIGN KEY constraint failed`。实现删除时必须先二选一：加一条迁移改成数据库层级联，或在应用层事务里显式递归删除。倾向应用层：依赖记录也要一并清理，且需要同时删掉后代作为任意一端的 `task_deps` 行，放在一个事务里更直观。

## D8 未知 parentId 的 404 归路由层（2025-09-22）

`readBoard` 对不存在的 `parentId` 返回该层的空看板，不做存在性校验。规范要求 404，但归属路由层：仓储只负责查询，接入 `GET /api/board/:parentId` 时由路由先查任务是否存在再调用。这条约定写在这里，避免接路由时漏掉。

## D9 后端默认端口由 3000 改为 3001（2025-09-22）

开发机上 3000 常被别的服务占用，启动直接失败。用户确认后把默认端口改为 `3001`，常量在 `apps/api/src/config.ts` 的 `DEFAULT_PORT`，仍可用 `PORT` 覆盖。

这条与规范不一致：`docs/spec.md` 的开发约定写的是「Vite 跑 5173，`server.proxy` 把 `/api` 代理到后端 3000」。规范文件只能由用户修改，待用户同步更新。做前端时 Vite 的代理目标从同一个 `PORT` 变量读取，避免两边漂移。
