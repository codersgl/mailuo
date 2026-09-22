# 决策记录

记录影响后续实现的决策，只追加。需求与规范见 `docs/intend.md`、`docs/spec.md`，两者由用户维护。

## D1 用 pnpm workspace 管理多应用（2026-09-22）

规范已定下 `apps/web` 与 `apps/api` 两个应用，需要一个工作区把两者的依赖和脚本组织起来。选 pnpm：单一 lockfile、依赖硬链接节省磁盘、`pnpm --filter` 可直接跑单个应用。

`apps/api` 需要准备 better-sqlite3 的原生产物，pnpm 默认拦截依赖的安装脚本，因此在 `pnpm-workspace.yaml` 里用 `allowBuilds` 映射放行 `better-sqlite3` 与 `esbuild`。

注意字段名：pnpm 11 用的是 `allowBuilds`（包名到布尔值的映射）。旧写法 `onlyBuiltDependencies` 会被 pnpm 自动改写进 `allowBuilds`，但值写成占位符 `set this to true or false`，装完依赖仍然不会执行安装脚本。放行后如果依赖已经装好，需要 `pnpm rebuild <包名>` 才会补跑脚本。

## D2 worktree 放在仓库内 `.worktrees/`（2026-09-22）

规范要求通过 worktree 推进、审阅后才合并主干。常见做法是把 worktree 放在仓库同级目录，但当前开发环境只允许写入仓库目录，因此放在 `.worktrees/<分支名>`，并在 `.gitignore` 中排除。

代价：worktree 内要各自 `pnpm install` 一份 `node_modules`。个人项目规模下可接受，换来的是每个 worktree 完全隔离。

## D3 迁移按编号 SQL 文件 + schema_migrations（2026-09-22）

规范要求手写编号 SQL 文件、启动时按序执行、执行记录落在 `schema_migrations`。补充两条实现约定：

- 每个迁移文件在**单个事务**内执行，失败整份回滚且不写入记录，下次启动重试。所以迁移文件内不能自己写 `BEGIN`/`COMMIT`（嵌套事务会直接报错）。
- 文件名必须是 `<数字>_<名字>.sql`。编号重复或缺前缀在启动时报错，避免靠文件名字典序决定执行顺序。

只向前迁移，不实现回滚。个人项目回滚迁移的复杂度高于它的收益，需要回退时直接改数据或删掉 `data/kanban.db` 重来。

已知限制：迁移在启动时执行，没有跨进程互斥。规范确定生产只跑一个进程，所以不做处理；但如果两个进程同时指向同一个不存在的数据库文件，后启动的那个会因「表已存在」而崩溃退出，重启即恢复。将来若真出现多进程启动，把「读取已应用列表 + 执行迁移」整体放进一个 `BEGIN IMMEDIATE` 事务即可。

## D4 数据库 snake_case，API camelCase（2026-09-22）

SQL 列名保持 `parent_id`、`archived_at` 这类写法，与规范里的建表语句一致；HTTP 响应统一转成 `parentId`、`archivedAt`，前端不需要在两种风格间切换。转换只发生在仓储层（`src/repositories/`），路由层直接返回仓储的返回结构。

## D5 完成列 id 固定为 `done`（2026-09-22）

进度计数要判断「子任务是否处于完成列」。规范里三列在迁移中写死，但没有指定 id。约定完成列 id 为 `done`，常量放在 `src/domain/columns.ts`，迁移 001 写入同一 id。改动必须同时改两处。

## D6 读接口的归档过滤参数（2026-09-22，第 4 步实现）

规范的看板查询里有「显示已归档时去掉 `archived_at IS NULL`」这一分支，归档开关属于第一批后半段的功能，所以第 2 步的 `readBoard(db, parentId)` 先固定只返回未归档任务，不提前留参数。

第 4 步做了归档接口，参数按原计划补上：`GET /api/board`、`GET /api/board/:parentId`、`GET /api/tree` 接受 `?includeArchived=1`（也接受 `true`，其它值一律当作关闭），缺省关闭。加在 `GET /api/tree` 上是因为规范要求文件树能「显示已归档」，否则归档后的任务没有任何界面入口可以取消归档。

参数解析：只有 `1` 与 `true` 算开启，其余（`0`、`false`、空串、`TRUE`、`yes`）都当关闭；重复出现时 Hono 取第一次的值。解析集中在 `src/routes/query.ts` 的 `wantsArchived`，读写接口共用。

`GET /api/tree` 的每一项带 `archivedAt`（`null` 表示未归档）。规范第 171 行原本把 tree 的字段写死为四个，前端在「显示已归档」模式下就无法区分归档节点，经用户同意后在规范里补上这个字段。

写接口的响应也读这个参数。原因：前端处于「显示已归档」模式时按 D18 整列替换，如果写响应固定只回未归档任务，改一个标题就会把当前列里的归档卡片抹掉。实测过这条路径（`PATCH /api/tasks/:id?includeArchived=1`），测试钉死。

进度计数口径不随开关变化：`childTotal` / `childDone` 的分母永远是未归档的直接子任务（规范「状态语义」一节），所以带上归档任务时也不会出现归档子任务混进分母的情况。

## D7 删除任务的级联策略：应用层事务递归删除（2026-09-22，第 4 步定案）

规范要求 `DELETE /api/tasks/:id` 级联删除后代及相关依赖记录。`tasks.parent_id` 没有 `ON DELETE CASCADE`，而外键约束已生效，所以直接 `DELETE` 一个有子任务的任务会抛 `FOREIGN KEY constraint failed`。

候选方案：

- 数据库层级联：加一条迁移把 `tasks.parent_id` 与 `task_deps` 的两端都改成 `ON DELETE CASCADE`。SQLite 改不了已有表的约束，必须重建表并搬数据。
- 应用层事务递归删除：一个事务里先递归取子树 id、删依赖、再删任务。

用户拍板选应用层。理由：`task_deps` 要「删除两端任一落在子树里的记录」，这段语义无论如何都得表达一次，放数据库里要靠两条 CASCADE 覆盖，与应用层的删除逻辑分成两处；重建表的迁移对个人项目是没有收益的复杂度。实现细节见 D25。

## D8 未知 parentId 的 404 归路由层（2026-09-22）

`readBoard` 对不存在的 `parentId` 返回该层的空看板，不做存在性校验。规范要求 404，但归属路由层：仓储只负责查询，接入 `GET /api/board/:parentId` 时由路由先查任务是否存在再调用。这条约定写在这里，避免接路由时漏掉。

## D9 后端默认端口由 3000 改为 3001（2026-09-22）

开发机上 3000 常被别的服务占用，启动直接失败。用户确认后把默认端口改为 `3001`，常量在 `apps/api/src/config.ts` 的 `DEFAULT_PORT`，仍可用 `PORT` 覆盖。

这条与规范不一致：`docs/spec.md` 的开发约定写的是「Vite 跑 5173，`server.proxy` 把 `/api` 代理到后端 3000」。规范文件只能由用户修改，待用户同步更新。做前端时 Vite 的代理目标从同一个 `PORT` 变量读取，避免两边漂移。

## D10 新建任务的 orders 取目标列内的 MAX + 1000（2026-09-22）

规范对 `POST /api/tasks` 写的是「在同一父任务下取 `MAX(orders) + 1000`」。同一父任务下可能同时有 `orders = 5000` 的进行中任务和 `orders = 1000` 的待办任务，按整层取 MAX 会让新任务在待办列里拿到 6000。

实现按 `(parent_id, column_id)` 取 MAX，即追加到目标列末尾。理由：`orders` 只用于列内排序（索引 `idx_tasks_board` 也是 `(parent_id, column_id, orders)`），跨列比较没有意义。若规范原意是整层取 MAX，需要用户更新规范并说明用途。

这条 MAX 刻意不排除已归档任务：归档任务将来取消归档时应回到原位，若把它们排除，新任务会插到它们前面。行为由测试固定，避免被「顺手过滤归档」改掉。

## D11 面包屑包含根看板与当前任务（2026-09-22）

`GET /api/breadcrumb/:taskId` 返回 `{ items: [{ id, title }] }`，第一项 `id` 为 `null`、标题固定「根看板」，随后是从根到 `taskId` 自身的每一层。

理由：规范里的例子是 `根看板 / 重构登录 / 前端部分`，最后一段就是当前看板所在的任务，所以接口把当前任务也返回。前端把 `id === null` 的一段链到 `/`、其余链到 `/board/:id`，不需要自己拼前缀。`id` 用 `null` 而不是特殊字符串，避免与真实 UUID 冲突。

## D12 入参用 strictObject，错误体只给第一条（2026-09-22）

- schema 一律 `z.strictObject`，字段名打错时返回 400 而不是被静默丢弃。未知字段的中文文案通过 `strictObject` 的 `error` 回调指定，只替换 `unrecognized_keys` 一种情况，请求体不是对象时仍用 Zod 默认描述。
- 规范要求错误统一为 `{ error: string }`，所以 `validationHook` 只取第一条 issue，压成 `字段名: 说明`（没有字段名时只给说明）。多字段同时出错时只说第一条，不引入 `details` 数组以免偏离契约。

## D13 归档任务下禁止新建子任务（2026-09-22）

`POST /api/tasks` 的 `parentId` 指向已归档任务时返回 400「父任务已归档」，而不是照常创建。归档是整棵子树一起隐藏，在归档任务下建的任务会立刻变成看不见的孤儿；正常界面进不到归档看板，这条只是防御。

## D14 本步的接口边界（2026-09-22）

本步实现：`GET /api/board/:parentId`、`GET /api/tree`、`GET /api/breadcrumb/:taskId`、`POST /api/tasks`、`PATCH /api/tasks/:id`（仅标题、描述、工期）。

未实现、留给下一步：`PATCH /api/tasks/:id` 的移动排序（`columnId` + `position`，要重写目标列 orders）、`PATCH /api/tasks/:id/parent`（要环检测）、`PATCH /api/tasks/:id/archive`（子树归档）、`DELETE /api/tasks/:id`（级联策略见 D7）。移动排序的入参 schema 也还没写，避免留下列表里没有实现的字段。

## D15 错误体统一与写接口的 Content-Type（2026-09-22）

- `onError` 里对 `HTTPException` 做归一化。原因：Hono 在请求体不是合法 JSON 时抛出的是 `HTTPException(400, { message })`，它自带的响应是 `text/plain` 的纯文本，直接放行会违反「错误统一为 `{ error: string }`」的契约。现在只要响应不是 `application/json` 就包成 JSON 错误体，文案也把 Hono 的 `Malformed JSON in request body` 换成中文。
- 写接口（POST/PATCH）要求 `Content-Type` 含 `application/json`，否则返回 400「Content-Type 必须是 application/json」。原因：zValidator 在 Content-Type 不匹配时会跳过解析，请求体变成 `undefined`，报错会变成「列 id 必须是字符串」，而字段其实就在 body 里（`curl -d` 默认发 `application/x-www-form-urlencoded`，很容易踩）。
- `POST /api/tasks` 的校验顺序固定为：字段格式 → `columnId` 存在（400）→ `parentId` 存在（404）→ 父任务未归档（400）。两者同时非法时先报列错误，顺序由测试钉死，调整顺序会改变状态码。

## D16 已归档任务：写接口拒绝，读接口照常（2026-09-22）

写接口一律拒绝归档任务：`POST /api/tasks` 在归档父任务下新建返回 400「父任务已归档」；`PATCH /api/tasks/:id` 与 `PATCH /api/tasks/:id/parent` 对归档任务本身返回 400「任务已归档」。归档语义是「收起来」，允许继续改动它会让归档状态与实际内容脱节，也会让「写接口返回的 `columnTasks` 必然包含 `task`」这条不变量失效（归档任务不在任何列列表里）。要改先取消归档。

读接口不拦截：`GET /api/board/:parentId` 对归档任务返回 200 与空看板。读只做存在性判断，多一个 404 判定只会让「归档任务恢复后再点进去」这类边界多一次失败路径，收益不大。

## D17 成环与父行缺失按脏数据处理（2026-09-22）

`readBreadcrumb` 遇到父子成环抛 `TaskCycleError`（→500 并记日志），遇到父行缺失返回 `undefined`（→404）。这两种情况在外键开启且只走接口的前提下不可达，写出来是为了不在脏数据上返回一条看起来正常但错误的面包屑。测试用直接改库的方式固定这两个行为。

## D18 写接口统一返回 `{ task, columnTasks }`（2026-09-22）

`PATCH /api/tasks/:id` 与 `PATCH /api/tasks/:id/parent` 都返回 `{ task, columnTasks }`：

- `task`：改动后的任务记录（用于字段编辑后刷新卡片）。
- `columnTasks`：该任务所在列的完整有序列表，元素与看板卡片同构（含 `childTotal` / `childDone`）。

理由：规范要求移动后「后端重写目标列内所有任务的 orders 并返回该列任务列表」，前端不做本地重排。字段编辑也返回整列，形状统一，前端拿到响应就能整列替换，不需要为一个接口准备两种解析分支。这是对第 2 步 `PATCH` 返回裸任务对象的改写，没有保留旧形状（个人项目，无外部调用方）。

第 4 步补了一条：`columnTasks` 与请求的 `?includeArchived` 保持一致（见 D6），这样「显示已归档」模式下整列替换不会丢卡片。缺省仍是只含可见任务。

## D19 移动的 position 是目标列里的 0 基下标（2026-09-22）

`PATCH /api/tasks/:id` 的 `{ columnId, position }` 中，`position` 是「任务移出原位置后，插入目标列的下标」，从 0 开始，超出列长度按末尾处理（内部 `Math.min(position, siblings.length)`；schema 已保证非负，所以没有下界处理）。

例：待办列是 `A B C`，把 `C` 移到 `position: 1`，结果是 `A C B`（先移出 C 得到 `A B`，再插到下标 1）。前端从拖拽得到的落点下标可以直接传，不需要自己减一。

重排只在 `(parent_id, column_id)` 范围内发生，只重写未归档任务，编号从 `ORDERS_STEP` 起逐个递增。位置与列都没变的行不写库，避免「拖回原位」把整列的 `updated_at` 全部刷新。

## D20 已归档任务不参与重排（2026-09-22）

移动只重写可见（未归档）任务的 orders，同列里已归档的旁观任务保留原值。它们不参与渲染，重排后可能与可见任务撞号，影响仅限于「取消归档后落点不精确」。另一种做法是把归档任务也纳入编号，但那会让 `position` 的含义（可见列表下标）与内部编号错位，代价更大。行为由测试固定。

被移动的任务本身若是已归档，请求直接被拒（D16），不存在「归档任务被重新编号」的情况。

## D21 改父级：子树跟随，环检测用递归 CTE（2026-09-22）

`PATCH /api/tasks/:id/parent` 入参 `{ parentId, columnId }`（`parentId` 为 `null` 表示移到根看板）：

- 任务挂到新父级下并追加到目标列末尾，`orders` 取新范围内该列的 `MAX + 1000`（取值时排除任务自己，避免同范围移动时多留一个空档）。
- 子树跟着父任务走，不需要额外处理（子任务不参与列渲染）。
- 环检测：用递归 CTE 求任务的子树，判断 `parentId` 是否落在其中（含自身）。CTE 用 `UNION` 而不是 `UNION ALL`，脏数据成环时递归也能终止。命中返回 400「不能把任务挂到自己或自己的后代下」。
- 新父任务不存在返回 404、已归档返回 400、`columnId` 不存在返回 400；同父同级移动等价于「追加到该列末尾」。

## D22 本步的接口边界（2026-09-22）

本步实现：`PATCH /api/tasks/:id` 的移动（`columnId` + `position`，可与字段更新同时提交）与 `PATCH /api/tasks/:id/parent`。

未实现：`PATCH /api/tasks/:id/archive`（子树归档与取消归档的父链恢复）、`DELETE /api/tasks/:id`（级联策略见 D7）。

## D23 写接口的校验顺序统一（2026-09-22）

两条 PATCH 路由统一为：任务存在（404）→ 任务未归档（400）→ 目标列存在（400）→ 父级检查（自环 400 / 父任务不存在 404 / 父任务已归档 400）。

理由：把「目标资源不存在」放在「入参非法」之前更符合直觉，两个接口顺序一致也避免前端为同一类错误准备两套判断。与 D15 里 `POST /api/tasks` 的顺序（先列后父）不同，POST 没有「任务本身」这个主体，先报入参错误更合适。两种顺序都由测试钉死。


## D24 归档：整棵子树一起归档，取消归档恢复父链（2026-09-22）

`PATCH /api/tasks/:id/archive` 入参 `{ archived: boolean }`（必填，没有默认值：省略时无法区分意图）。

- 归档：任务及其全部后代都置 `archived_at`。已经归档的行保留原时间戳，所以重复归档是幂等空操作，也不会白刷 `updated_at`。
- 取消归档：恢复整棵子树，并沿 `parent_id` 向上把仍处于归档状态的祖先一并恢复（规范要求，否则任务会挂在一个不显示的父节点下）。只改 `archived_at IS NOT NULL` 的行，本来就没归档的祖先不会被刷新 `updated_at`。
- 子树与祖先链都用「先读 id，再 `UPDATE ... WHERE id IN (...)`」，不在 `UPDATE` 里内联递归 CTE：那样读源与写目标是同一批行，是否先物化取决于 SQLite 实现。
- 响应是 `{ task, columnTasks }`，与其它写接口同构。归档后任务不在任何列里，所以默认情况下 `columnTasks` 不含它（这是唯一允许「响应的 `task` 不在 `columnTasks` 中」的接口，D18 的不变量在这里失效，前端按「整列替换」处理即可）；取消归档后它回到原列，且因为归档不动 `orders`，位置与原值一致。
- 请求带 `?includeArchived=1` 时 `columnTasks` 含归档任务（D6）：刚归档的任务会作为归档卡片留在列表里，前端不需要为这一个接口特判。归档与取消归档都不重排 `orders`，所以带不带归档，可见任务的相对顺序一致。
- 归档是唯一接受已归档任务的写接口，D16 在这里不适用：它正是把任务放进或取出归档状态的入口。
- 子树归档用一条 `UPDATE` 完成，不逐层递归：SQLite 的递归 CTE 一次取全部 id 更简单。

## D25 删除：先依赖后任务，任务行一条 DELETE 删整棵子树（2026-09-22）

`DELETE /api/tasks/:id` 在 `BEGIN IMMEDIATE` 事务里按三步做：

1. 递归取子树 id（含任务自己）。
2. `DELETE FROM task_deps WHERE predecessor_id IN (...) OR successor_id IN (...)`：一条语句覆盖「任务作为任意一端」的记录，无关依赖不动。
3. `DELETE FROM tasks WHERE id IN (...)`：一条语句删掉整棵子树。

顺序不能反：外键已开启，任务先删会立刻撞上 `task_deps` 的约束。第 3 步之所以能一条语句删掉父子两端，是因为 SQLite 的立即外键约束在**语句结束时**检查，同一语句里删掉父子不构成中间态；这条行为由「四层链」用例钉死，若将来 SQLite 改了语义测试会先失败。

响应是 `{ columnTasks }`（没有 `task` 可回），取删除前记录的父级与列，前端整列替换。删除没有请求体，所以不要求 `Content-Type`。

已归档任务可以删除：归档是「收起来」，删除是清理入口，这是 D16 的第二个例外。

## D26 本步的接口边界（2026-09-22）

本步实现：`PATCH /api/tasks/:id/archive`、`DELETE /api/tasks/:id`，以及 D6 里的 `?includeArchived=1` 参数（读写接口都认，新增 `src/routes/query.ts` 存放解析函数）。

未实现、留给下一批：前端（React + Vite + Tailwind）、依赖与关键路径（`PUT /api/tasks/:id/deps`、`GET /api/board/:parentId/cpm`）。`task_deps` 表从第 1 步就建好了，本步的删除会清理它，但还没有写入依赖的接口。

## D27 前端脚手架与依赖选型（2026-09-22）

- React 19 + Vite 7 + Tailwind 4。Tailwind 走 `@tailwindcss/vite` 插件加 CSS 里一行 `@import "tailwindcss"`，不建 `tailwind.config.js`：v4 的扫描范围和主题都放在 CSS 里。
- tsconfig 拆两份：`apps/web/tsconfig.json`（浏览器代码，`lib` 带 DOM、`jsx: react-jsx`、`moduleResolution: bundler`、`types: [vite/client]`）与 `apps/web/tsconfig.node.json`（`vite.config.ts`、`vitest.config.ts`，`types: [node]`）。两份都继承根 `tsconfig.base.json`，只覆盖需要不同的项。拆开是因为 node 与 DOM 类型混在一起会让同一批 API 出现两套签名。
- 前端 import 不写 `.js` 扩展名（bundler 解析），与 `apps/api` 的 NodeNext 写法不同——两边各自的运行方式决定，不要互相统一。
- 前端测试用 vitest + jsdom + `@testing-library/react`：本步唯一的异步逻辑 `useBoard` 有竞态，不真实挂载 React 就测不到。

## D28 开发时用 Vite 代理，端口与后端共用 PORT（2026-09-22）

`pnpm dev:api` 起后端（默认 3001），`pnpm dev:web` 起 Vite（默认 5173），Vite 的 `server.proxy` 把 `/api` 转发到 `http://127.0.0.1:${process.env.PORT ?? '3001'}`。前端代码里只写相对路径，不出现端口号；换端口时两个命令都传同一个 `PORT`，这是 D9 定下「代理目标从同一个变量读」的落地。

## D29 设计令牌来自定版原型 A（2026-09-22）

按项目规则先用子代理做了三版静态 HTML 原型（浅灰工具风 / 现代卡片风 / 深色紧凑），用同一份示例数据渲染，用户选定 A 版。

- 令牌集中在 `apps/web/src/index.css` 的 `@theme`：页面底色 `#f6f7f9`、卡片白、边框 `#e6e8ec`、唯一强调色 `#4c6fce`、正文 13px、圆角 5px。组件里只用令牌对应的工具类，不写魔法色值；改配色只动这一处。
- 保留原型的两个语义样式：完成列的卡片整体降一档（标题变次要色、进度文案用强调色），未估工期的 chip 用虚线且文字弱化。
- 原型文件在定版并实现后删除，临时产物不入版本库。
- `done` / `doing` 两个列 id 在前端集中到 `apps/web/src/domain/columns.ts`，注释写明改 id 要同步改的三处：迁移 `001_init.sql`、`apps/api/src/domain/columns.ts`、这个文件。此前散在两个组件里，会让 D5 的同步约束从两处变成四处且没人知道。

## D30 本步边界与 useBoard 的取舍（2026-09-22）

本步只做：前端工作区与构建链路、读 `GET /api/board` 渲染根看板三列卡片（标题、描述一行截断、子任务进度、工期 chip）、加载与失败状态（失败显示后端的中文文案并给重试按钮）、空列显示一行「暂无任务」。

未实现、留给后续步骤：左侧文件树、面包屑跳转、点卡片进入子看板、侧边编辑面板、卡片编辑入口、拖拽、归档开关、新建 / 删除 / 归档。因此卡片上没有编辑热区——不做点了没反应的控件。

两点取舍：

- `useBoard` 用 effect 内的 `cancelled` 闭包丢弃过期响应，不引入 `AbortController`。只读接口的重复请求无害（开发环境 StrictMode 下每次挂载会发两次），而 `AbortController` 还要额外区分「主动取消」与「真失败」两个分支。做写接口或导航时再引入。
- 面包屑目前是前端常量「根看板」。导航那一步改成读 `GET /api/breadcrumb/:taskId`（D11），常量随之删除。
