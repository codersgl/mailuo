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

## D10 新建任务的 orders 取目标列内的 MAX + 1000（2025-09-22）

规范对 `POST /api/tasks` 写的是「在同一父任务下取 `MAX(orders) + 1000`」。同一父任务下可能同时有 `orders = 5000` 的进行中任务和 `orders = 1000` 的待办任务，按整层取 MAX 会让新任务在待办列里拿到 6000。

实现按 `(parent_id, column_id)` 取 MAX，即追加到目标列末尾。理由：`orders` 只用于列内排序（索引 `idx_tasks_board` 也是 `(parent_id, column_id, orders)`），跨列比较没有意义。若规范原意是整层取 MAX，需要用户更新规范并说明用途。

这条 MAX 刻意不排除已归档任务：归档任务将来取消归档时应回到原位，若把它们排除，新任务会插到它们前面。行为由测试固定，避免被「顺手过滤归档」改掉。

## D11 面包屑包含根看板与当前任务（2025-09-22）

`GET /api/breadcrumb/:taskId` 返回 `{ items: [{ id, title }] }`，第一项 `id` 为 `null`、标题固定「根看板」，随后是从根到 `taskId` 自身的每一层。

理由：规范里的例子是 `根看板 / 重构登录 / 前端部分`，最后一段就是当前看板所在的任务，所以接口把当前任务也返回。前端把 `id === null` 的一段链到 `/`、其余链到 `/board/:id`，不需要自己拼前缀。`id` 用 `null` 而不是特殊字符串，避免与真实 UUID 冲突。

## D12 入参用 strictObject，错误体只给第一条（2025-09-22）

- schema 一律 `z.strictObject`，字段名打错时返回 400 而不是被静默丢弃。未知字段的中文文案通过 `strictObject` 的 `error` 回调指定，只替换 `unrecognized_keys` 一种情况，请求体不是对象时仍用 Zod 默认描述。
- 规范要求错误统一为 `{ error: string }`，所以 `validationHook` 只取第一条 issue，压成 `字段名: 说明`（没有字段名时只给说明）。多字段同时出错时只说第一条，不引入 `details` 数组以免偏离契约。

## D13 归档任务下禁止新建子任务（2025-09-22）

`POST /api/tasks` 的 `parentId` 指向已归档任务时返回 400「父任务已归档」，而不是照常创建。归档是整棵子树一起隐藏，在归档任务下建的任务会立刻变成看不见的孤儿；正常界面进不到归档看板，这条只是防御。

## D14 本步的接口边界（2025-09-22）

本步实现：`GET /api/board/:parentId`、`GET /api/tree`、`GET /api/breadcrumb/:taskId`、`POST /api/tasks`、`PATCH /api/tasks/:id`（仅标题、描述、工期）。

未实现、留给下一步：`PATCH /api/tasks/:id` 的移动排序（`columnId` + `position`，要重写目标列 orders）、`PATCH /api/tasks/:id/parent`（要环检测）、`PATCH /api/tasks/:id/archive`（子树归档）、`DELETE /api/tasks/:id`（级联策略见 D7）。移动排序的入参 schema 也还没写，避免留下列表里没有实现的字段。

## D15 错误体统一与写接口的 Content-Type（2025-09-22）

- `onError` 里对 `HTTPException` 做归一化。原因：Hono 在请求体不是合法 JSON 时抛出的是 `HTTPException(400, { message })`，它自带的响应是 `text/plain` 的纯文本，直接放行会违反「错误统一为 `{ error: string }`」的契约。现在只要响应不是 `application/json` 就包成 JSON 错误体，文案也把 Hono 的 `Malformed JSON in request body` 换成中文。
- 写接口（POST/PATCH）要求 `Content-Type` 含 `application/json`，否则返回 400「Content-Type 必须是 application/json」。原因：zValidator 在 Content-Type 不匹配时会跳过解析，请求体变成 `undefined`，报错会变成「列 id 必须是字符串」，而字段其实就在 body 里（`curl -d` 默认发 `application/x-www-form-urlencoded`，很容易踩）。
- `POST /api/tasks` 的校验顺序固定为：字段格式 → `columnId` 存在（400）→ `parentId` 存在（404）→ 父任务未归档（400）。两者同时非法时先报列错误，顺序由测试钉死，调整顺序会改变状态码。

## D16 已归档任务：写接口拒绝，读接口照常（2025-09-22）

写接口一律拒绝归档任务：`POST /api/tasks` 在归档父任务下新建返回 400「父任务已归档」；`PATCH /api/tasks/:id` 与 `PATCH /api/tasks/:id/parent` 对归档任务本身返回 400「任务已归档」。归档语义是「收起来」，允许继续改动它会让归档状态与实际内容脱节，也会让「写接口返回的 `columnTasks` 必然包含 `task`」这条不变量失效（归档任务不在任何列列表里）。要改先取消归档。

读接口不拦截：`GET /api/board/:parentId` 对归档任务返回 200 与空看板。读只做存在性判断，多一个 404 判定只会让「归档任务恢复后再点进去」这类边界多一次失败路径，收益不大。

## D17 成环与父行缺失按脏数据处理（2025-09-22）

`readBreadcrumb` 遇到父子成环抛 `TaskCycleError`（→500 并记日志），遇到父行缺失返回 `undefined`（→404）。这两种情况在外键开启且只走接口的前提下不可达，写出来是为了不在脏数据上返回一条看起来正常但错误的面包屑。测试用直接改库的方式固定这两个行为。

## D18 写接口统一返回 `{ task, columnTasks }`（2025-09-22）

`PATCH /api/tasks/:id` 与 `PATCH /api/tasks/:id/parent` 都返回 `{ task, columnTasks }`：

- `task`：改动后的任务记录（用于字段编辑后刷新卡片）。
- `columnTasks`：该任务所在列的完整有序列表，元素与看板卡片同构（含 `childTotal` / `childDone`）。

理由：规范要求移动后「后端重写目标列内所有任务的 orders 并返回该列任务列表」，前端不做本地重排。字段编辑也返回整列，形状统一，前端拿到响应就能整列替换，不需要为一个接口准备两种解析分支。这是对第 2 步 `PATCH` 返回裸任务对象的改写，没有保留旧形状（个人项目，无外部调用方）。

## D19 移动的 position 是目标列里的 0 基下标（2025-09-22）

`PATCH /api/tasks/:id` 的 `{ columnId, position }` 中，`position` 是「任务移出原位置后，插入目标列的下标」，从 0 开始，超出列长度按末尾处理（内部 `Math.min(position, siblings.length)`；schema 已保证非负，所以没有下界处理）。

例：待办列是 `A B C`，把 `C` 移到 `position: 1`，结果是 `A C B`（先移出 C 得到 `A B`，再插到下标 1）。前端从拖拽得到的落点下标可以直接传，不需要自己减一。

重排只在 `(parent_id, column_id)` 范围内发生，只重写未归档任务，编号从 `ORDERS_STEP` 起逐个递增。位置与列都没变的行不写库，避免「拖回原位」把整列的 `updated_at` 全部刷新。

## D20 已归档任务不参与重排（2025-09-22）

移动只重写可见（未归档）任务的 orders，同列里已归档的旁观任务保留原值。它们不参与渲染，重排后可能与可见任务撞号，影响仅限于「取消归档后落点不精确」。另一种做法是把归档任务也纳入编号，但那会让 `position` 的含义（可见列表下标）与内部编号错位，代价更大。行为由测试固定。

被移动的任务本身若是已归档，请求直接被拒（D16），不存在「归档任务被重新编号」的情况。

## D21 改父级：子树跟随，环检测用递归 CTE（2025-09-22）

`PATCH /api/tasks/:id/parent` 入参 `{ parentId, columnId }`（`parentId` 为 `null` 表示移到根看板）：

- 任务挂到新父级下并追加到目标列末尾，`orders` 取新范围内该列的 `MAX + 1000`（取值时排除任务自己，避免同范围移动时多留一个空档）。
- 子树跟着父任务走，不需要额外处理（子任务不参与列渲染）。
- 环检测：用递归 CTE 求任务的子树，判断 `parentId` 是否落在其中（含自身）。CTE 用 `UNION` 而不是 `UNION ALL`，脏数据成环时递归也能终止。命中返回 400「不能把任务挂到自己或自己的后代下」。
- 新父任务不存在返回 404、已归档返回 400、`columnId` 不存在返回 400；同父同级移动等价于「追加到该列末尾」。

## D22 本步的接口边界（2025-09-22）

本步实现：`PATCH /api/tasks/:id` 的移动（`columnId` + `position`，可与字段更新同时提交）与 `PATCH /api/tasks/:id/parent`。

未实现：`PATCH /api/tasks/:id/archive`（子树归档与取消归档的父链恢复）、`DELETE /api/tasks/:id`（级联策略见 D7）。

## D23 写接口的校验顺序统一（2025-09-22）

两条 PATCH 路由统一为：任务存在（404）→ 任务未归档（400）→ 目标列存在（400）→ 父级检查（自环 400 / 父任务不存在 404 / 父任务已归档 400）。

理由：把「目标资源不存在」放在「入参非法」之前更符合直觉，两个接口顺序一致也避免前端为同一类错误准备两套判断。与 D15 里 `POST /api/tasks` 的顺序（先列后父）不同，POST 没有「任务本身」这个主体，先报入参错误更合适。两种顺序都由测试钉死。


