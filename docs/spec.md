# 脉络规范

## 项目定位

- 个人使用的任务看板网页应用。
- 单用户，无账号系统，无协作。

## 核心模型

任务和看板是同一个东西。一个任务一旦有子任务，它自己就是一个看板。

- 看板 = 一组共享同一个父任务的任务。
- 根看板 = `parent_id IS NULL` 的任务集合。
- 进入某个任务后的看板 = `parent_id = 该任务 id` 的任务集合。
- 层级深度不设限制。
- 项目就是根任务，不单独建表。一个项目对应一个 `parent_id IS NULL` 的任务。

## 功能范围

### 第一批

- 单个根项目。
- 三列固定：待办、进行中、完成。全项目共用，不按看板区分。
- 任务增删改。
- 任务描述编辑面板：右侧抽屉改标题、描述、工期；归档与删除在卡片的「⋯」菜单里，不放抽屉。
- 工期录入：天 / 小时 / 分三个输入框（1 天 = 480 分钟），留空表示未估、0 表示瞬时。
- 拖拽：跨列移动、同列内排序。
- 任务树导航：左侧树视图展示完整层级，可展开折叠，节点可拖动改变父级。
- 点击任务进入子看板，面包屑导航，接浏览器历史。
- 卡片显示直接子任务进度计数。
- 归档与取消归档。
- 深色模式。

### 第二批

- 全库搜索：匹配任务标题与描述，跨层级，不受当前看板限制。
- 界面：顶栏搜索框 + 主区结果页；结果按列分组，显示层级路径与工期，命中片段高亮。
- 键盘：↑ ↓ 选择、Enter 进入选中的任务、Esc 返回看板。

### 第三批

- 任务依赖（DAG）。
- 关键路径计算与可视化。

### 第四批

- 工期提醒：进行中任务的用时累计，以及卡片与任务树上的「临近 / 超期」标记。

### 明确排除

以下功能本版本不做，也不为它们预留结构。

- 账号登录、多用户、权限。
- 实时同步、WebSocket、离线支持。
- 卡片在列视图内跨层拖拽。跨层改父级只在任务树中进行。
- 每个看板自定义列。
- 手动填写的截止日期。工期提醒只看工期估算，不引入日期字段。
- 应用外提醒：系统通知、邮件、桌面弹窗。提醒只出现在应用内的卡片与任务树上。
- 标签、附件。
- 移动端原生壳。

## 技术栈

- 前端：React + Vite，样式用 Tailwind CSS，响应式布局。
- 后端：TypeScript + Hono。
- 数据库：SQLite，驱动用 better-sqlite3，开启 `PRAGMA foreign_keys = ON`。
- 入参校验：Zod，经 `@hono/zod-validator` 做。

## 项目结构

```
mailuo/
  apps/web/                    React 前端
    public/                    图标产物（由 pnpm icons 生成，提交进版本库）
  apps/api/                    Hono 后端
    migrations/                SQL 迁移文件
  brand/                       品牌图标母版（SVG，唯一手改的地方）
  scripts/                     构建脚本
  data/kanban.db               SQLite 文件，不入版本库
```

- 开发：Vite 跑 5173，`server.proxy` 把 `/api` 代理到后端 3001。
- 生产：Hono 提供 `/api/*`，并用 `serveStatic` 托管 `apps/web/dist`，只跑一个进程。
- 迁移：手写编号 SQL 文件，启动时按序执行，已执行的记录在 `schema_migrations` 表。
- 监听与访问控制：默认只绑 `127.0.0.1`（只服务本机）。`HOST` 改监听地址（例如 `0.0.0.0` 供同网段访问），`HOST_ALLOW` 追加 Host 白名单里额外的机器名/域名；用 IP 访问时本机网卡地址自动放行。请求的 Host 不在白名单、或写请求的 Origin 不在白名单时一律拒绝——在没有鉴权的前提下，这是挡 DNS rebinding 的那一层。

## 数据模型

```sql
CREATE TABLE columns (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  orders     INTEGER NOT NULL
);

CREATE TABLE tasks (
  id               TEXT    PRIMARY KEY,
  parent_id        TEXT    REFERENCES tasks(id),
  column_id        TEXT    NOT NULL REFERENCES columns(id),
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL DEFAULT '',
  duration_minutes INTEGER CHECK (
    duration_minutes IS NULL OR (typeof(duration_minutes) = 'integer' AND duration_minutes >= 0)
  ),
  spent_minutes    INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(spent_minutes) = 'integer' AND spent_minutes >= 0
  ),
  running_since    TEXT,
  orders           INTEGER NOT NULL,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  archived_at      TEXT
);

CREATE TABLE task_deps (
  predecessor_id TEXT NOT NULL REFERENCES tasks(id),
  successor_id   TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);

CREATE INDEX idx_tasks_board    ON tasks(parent_id, column_id, orders);
CREATE INDEX idx_tasks_parent   ON tasks(parent_id);
CREATE INDEX idx_deps_successor ON task_deps(successor_id);
```

约束与约定：

- `id` 用 UUID v4 字符串。
- 时间戳用 ISO 8601 UTC 字符串。
- `orders` 为间隔 1000 的整数。同一 `(parent_id, column_id)` 内整体重写。
- 三列在迁移里写死，`orders` 分别为 1000、2000、3000。
- `archived_at` 非空表示归档。
- `duration_minutes` 单位分钟（整数）：`NULL` 表示未估工期，`0` 表示瞬时任务，其余是工期分钟数。上限 9999 天（4799520 分钟），由接口校验拒绝超出者；数据库的 CHECK 只保证「非负整数」这一层，不加时间上限（改 CHECK 要重建表，而接口是唯一写入口）。
- `spent_minutes` 是已结算的累计用时（分钟），`running_since` 是当前这一段的开始时刻（非空表示任务正在计时）。两者都由服务端维护，接口不接受它们作为入参。
- 计时不变式：`running_since IS NOT NULL` ⟺ `column_id = 'doing' AND archived_at IS NULL`。每个会改到列或归档状态的写入口都要维持它：新建、移动、改父级、归档、取消归档。取消归档会把重新可见且处在「进行中」的任务重新开始计时，否则它下次被拖出这一列时不会被结算。
- 分钟向下取整，不足一分钟的零头不计入已用。代价是反复进出「进行中」时秒级零头会丢，但工期本身就是估算，不值得为它存秒。
- 迁移 003 为已在「进行中」的任务回填 `running_since`，取**迁移执行的时刻**而不是 `updated_at`：后者只是最后一次改动的时刻，一个放着没动半年的任务会被算成「已用 180 天」。
- `task_deps` 是无环有向图（DAG）。写入前必须检测环，检测到则拒绝并返回 `409`。
- 依赖两端必须 `parent_id` 相同。跨层依赖拒绝并返回 `400`。

## 状态语义

- 任务所处的工作阶段由 `column_id` 表达。
- 不设 `done` 字段。子任务是否完成由它所在的列决定。
- 父任务的完成不自动推导。不实现"子任务全部完成则父任务自动移入完成列"。
- 进度计数口径：分母 = 直接子任务中 `archived_at IS NULL` 的数量；分子 = 其中处于"完成"列的数量。单层统计，不递归下钻。

## 归档

- 归档一个任务时，其整棵子树一并置 `archived_at`。
- 取消归档恢复整棵子树。若恢复时父任务仍处于归档状态，父任务一并恢复，避免出现挂在不显示父节点上的孤儿。
- 已归档任务默认不出现在看板列和任务树中。
- 侧栏提供一个"显示已归档"总开关，默认关闭。开关状态只存在前端，不落库。

## 工期提醒

- 计时口径：只有处在「进行中」列里的任务在走表，用累计制——`spent_minutes` 是已结算的部分，加上 `running_since` 到现在这一段就是「已用」。拖进「进行中」即开始，拖出去即暂停并结算，所以不需要额外的「开始 / 暂停」按钮，待办也就成了纯粹的排期区。
- 剩余 = 工期 − 已用。判定两档，互斥且超期优先：
  - **超期**：已用 ≥ 工期。不区分是否在计时——停在待办但已用超过工期的任务照样标出来，那是一条事实，也是「当初估少了」的信号。已用正好等于工期时文案是「工期已用完」，不写「超 0 分」。
  - **临近**：任务正在计时，且剩余 ≤ 10% 工期。停在待办的任务不进入这一档：它没在消耗时间，「临近」无从谈起。
- 阈值是严格的 10%，不给短任务写特例。T = 20 分钟的任务只在最后 2 分钟显示「临近」，窗口宽度自己跟着工期缩放，不会误报；真正兜底的信号是「超期」。
- 不提醒的情形：未估工期（`NULL`）与工期 0（瞬时任务）没有可用的时间窗；完成列与已归档任务不再提醒。这三类仍然照常记账（`spent_minutes` 照样累加），只是不产生标记。
- 判定不落库，也没有对应的接口参数：后端只存事实（工期、已用、这一段何时开始），前端用本地的「现在」重算。看板与任务树各挂一个 30 秒的定时器，所以标记会在页面开着的时候自己变档，不必等下一次取数。
- 判定只有一份实现（前端的 `domain/reminder.ts`）。不在后端再算一份：同一个任务在两次取数之间就会换档，两份实现迟早分叉（与关键边的判定同一个理由）。
- 提醒不做应用外推送（系统通知、邮件、桌面弹窗），也不引入截止日期字段。

## 关键路径

- 按 CPM（关键路径法，Critical Path Method）实现：任务为顶点，依赖为有向边。
- 不引入 AOE 的事件顶点表。AOE 要求单源单汇，而个人规划中多起点多终点是常态。
- 计算过程：拓扑排序得到正向序，按正向序算出每个任务的最早开始时间；按反向序算出最晚开始时间；松弛时间 `slack = 最晚开始 - 最早开始`，`slack = 0` 的任务构成关键路径。
- 工期以分钟为最小刻度存储（`duration_minutes`），CPM 全程按这个整数刻度做加减与比较。
- 未估工期（`NULL`）按 0 参与计算，并在界面上明确提示未估；`0` 表示瞬时任务，不阻断关键路径传递。
- 界面上的「天」「小时」只是换算：1 天 = 480 分钟（8 小时工作制）。这条换算只用于展示与输入，CPM 不引入工作日、周末或节假日的日历模型。
- 计算结果不落库，每次读取时重算。依赖或工期一变缓存即失效，个人规模下重算成本可忽略。

## API 契约

| 方法   | 路径                       | 用途                       |
| ------ | -------------------------- | -------------------------- |
| GET    | `/api/board`               | 根看板                     |
| GET    | `/api/board/:parentId`     | 指定任务的子看板           |
| GET    | `/api/board/cpm`           | 根看板的依赖图与关键路径（第三批） |
| GET    | `/api/tree`                | 完整任务树（默认不含归档） |
| GET    | `/api/breadcrumb/:taskId`  | 沿 parent_id 回溯的面包屑  |
| POST   | `/api/tasks`               | 新建任务                   |
| PATCH  | `/api/tasks/:id`           | 改标题、描述、工期，或移动 |
| PATCH  | `/api/tasks/:id/parent`    | 改父级（任务树拖动）       |
| PATCH  | `/api/tasks/:id/archive`   | 归档或取消归档             |
| DELETE | `/api/tasks/:id`           | 删除任务                   |
| GET    | `/api/search`              | 全库搜索（第二批）         |
| GET    | `/api/board/:parentId/cpm` | 依赖图与关键路径（第三批） |
| PUT    | `/api/tasks/:id/deps`      | 设置前置依赖（第三批）     |

`GET /api/board*` 返回该层的列、任务，以及每个任务的直接子任务计数，用一次查询算出。`parentId` 为空时走根看板查询：

```sql
SELECT t.*, COUNT(c.id) AS child_total,
       SUM(CASE WHEN c.column_id = :doneColumnId THEN 1 ELSE 0 END) AS child_done
FROM tasks t
LEFT JOIN tasks c ON c.parent_id = t.id AND c.archived_at IS NULL
WHERE t.parent_id = :parentId        -- 根看板改为 t.parent_id IS NULL
  AND t.archived_at IS NULL          -- 显示已归档时去掉此条件
GROUP BY t.id
ORDER BY t.column_id, t.orders;
```

`GET /api/board`、`GET /api/board/:parentId`、`GET /api/tree` 都接受 `?includeArchived=1`（也接受 `true`），缺省关闭。这就是上面 SQL 里「显示已归档时去掉此条件」的开关：开关状态只存在前端，不落库，所以用查询参数传递。写接口响应里的 `columnTasks` 也认这个参数，前端在显示归档模式下整列替换才不会丢卡片。

`GET /api/tree` 一次返回任务的 `{ id, parentId, title, columnId, archivedAt, durationMinutes, spentMinutes, runningSince }`，默认不含归档任务，前端据此建树，展开时按需再取看板数据。`archivedAt` 非空表示该节点已归档，前端用它把归档节点画成另一种样式，而不是靠「节点是否出现在列表里」推断。树层级不深，个人规模下一次性返回比逐层懒加载简单。

工期与计时三件套（`durationMinutes`、`spentMinutes`、`runningSince`）在看板、任务树与写接口返回的 `task` 里都要带上：任务树要画每一层的提醒标记，而看板接口只返回当前这一层。搜索结果不带这三个字段——提醒只出现在卡片与任务树上。

`POST /api/tasks` 入参 `{ parentId, columnId, title }`。后端在同一父任务下取 `MAX(orders) + 1000` 作为新 `orders`，事务内完成。

`PATCH /api/tasks/:id` 的字段更新入参是 `title`、`description`、`durationMinutes`（分钟）。`durationMinutes` 传 `null` 表示改回未估工期，省略表示不动这一项，`0` 表示瞬时任务。

`PATCH /api/tasks/:id` 移动入参 `{ columnId, position }`。后端重写目标列内所有任务的 `orders` 并返回该列任务列表。排序逻辑只存在于后端，前端不做本地重排。

`PATCH /api/tasks/:id/parent` 入参 `{ parentId, columnId }`。改动父级后，任务在新父级下追加到目标列末尾，`orders` 取新同级的 `MAX(orders) + 1000`。必须拒绝把任务挂到自己的后代下，否则会形成环，返回 `400`。

`PATCH /api/tasks/:id/archive` 入参 `{ archived: boolean }`。服务端按上述归档规则处理整棵子树，返回 `{ task, columnTasks }`：`task` 是改动后的任务，`columnTasks` 是它所在列的列表（归档后该任务默认不在其中，取消归档后回到原列原位置）。

`PUT /api/tasks/:id/deps` 入参 `{ predecessorIds: string[] }`，整体替换该任务的前置依赖，空数组表示清空。写入前做环检测和同层校验：自己依赖自己或与已有依赖形成环返回 `409`，前置任务不存在返回 `404`，前置任务与目标任务不同 `parentId`（跨层）或已归档返回 `400`，同一个依赖在列表里重复出现返回 `400`。依赖集合没变化时不写库，也不刷新 `updated_at`。响应 `{ task, predecessorIds }`，其中 `predecessorIds` 按 id 升序——依赖在库里是一个集合（主键是两端），没有顺序，升序只是让响应稳定。

`GET /api/board/cpm` 是根看板的依赖图与关键路径，`GET /api/board/:parentId/cpm` 是某个任务看板的。根看板没有 `parentId`，所以单独占一条路径，与 `GET /api/board` 对称。两者都接受其它读接口共用的 `?includeArchived`（缺省只含未归档任务），跨层的脏依赖记录被忽略，不会返回端点不在这一层的边。返回结构：

```jsonc
{
  "parentId": null,            // null 表示根看板
  "projectDuration": 210,      // 该层总工期（分钟）：所有任务最早完成时间的最大值
  "nodes": [
    {
      "id": "…",
      "title": "…",
      "columnId": "todo",
      "durationMinutes": null, // null 表示未估；CPM 按 0 计算，界面据此提示未估
      "archivedAt": null,
      "earliestStart": 0,
      "earliestFinish": 0,
      "latestStart": 0,
      "latestFinish": 0,
      "slack": 0,              // 最晚开始 − 最早开始；0 表示这个任务在关键路径上
      "critical": true
    }
  ],
  "edges": [{ "predecessorId": "…", "successorId": "…", "critical": true }]
}
```

节点顺序是列 `orders` 加列内 `orders`，前端不需要再排一次。边上的 `critical` 是「两端都关键，且前置任务的最早完成时间等于后继任务的最早开始时间」——只看两端是否关键，会把关键任务之间的非紧边也标成关键。空层返回 `projectDuration: 0` 与两个空数组。计算结果不落库，依赖或工期一变，下一次读取就是重算的结果。

`GET /api/search` 入参 `q`（必需，去掉两端空白后不能为空，最多 100 字）与其它读接口共用的 `?includeArchived`。匹配标题与描述，**只做连续子串**：不切词、不做顺序模糊匹配，大小写对 ASCII 不敏感，`%`、`_`、`\` 按字面处理。排序是「标题命中的排前面」→「最近更新的排前面」→ `id`，不做相关度打分。一次最多返回 50 条，超出时置 `truncated`，界面只提示「找到 N 条以上任务」而不写死这个 50。返回结构：

```jsonc
{
  "columns": [{ "id": "todo", "name": "待办", "orders": 1000 }], // 列字典，结果页按它分组
  "results": [
    {
      "id": "…",
      "title": "…",
      // 命中在描述里时给一段以关键词为中心的上下文；只有标题命中时为 null
      "snippet": "…",
      "columnId": "todo",
      "durationMinutes": null,        // null 表示未估，结果行不显示工期
      "archivedAt": null,
      // 祖先链，从根看板到该任务的父任务，不含任务自己
      "path": [{ "id": null, "title": "根看板" }]
    }
  ],
  "truncated": false
}
```

列字典跟着结果一起返回，而不是让前端去读看板：搜索是全库的，不该因为当前这一层看板取不到就画不出来。父链成环这类脏数据只让那一条结果的 `path` 为空，不让整个搜索报错。多余的查询参数一律忽略（与其它读接口一致）。

`DELETE /api/tasks/:id` 级联删除其所有后代任务，并删除这些任务作为任意一端的依赖记录。返回 `{ columnTasks }`，即该任务原所在列的列表，前端整列替换即可。

错误统一返回 `{ error: string }`：`400` 入参非法，`403` Host 或 Origin 不在允许列表，`404` 目标不存在，`409` 形成环，`413` 请求体超过 256KB。

## 界面行为

导航：

- 路由为 `/board/:taskId`，根看板为 `/`。
- 左侧任务树展示完整层级，展开折叠状态只存在前端本地存储，不落库。
- 任务树节点可拖动改变父级，走 `PATCH /api/tasks/:id/parent`。树的拖动是唯一允许跨层改父级的入口。
- 面包屑形如 `根看板 / 重构登录 / 前端部分`，每一段可点击返回上层。
- 面包屑导航写入浏览器历史，后退键行为与面包屑一致。
- 点击卡片主体进入该任务的看板。卡片角落的「⋯」菜单给出编辑、归档 / 取消归档与删除；编辑打开侧边面板，只改标题、描述、工期；删除在菜单里就地二次确认。卡片主体与「⋯」必须是不同的热区，避免操作时误入下层。
- 空任务也允许进入，进入后是一个空看板。

拖拽：

- 列视图内允许跨列移动和同列排序，不允许跨层改父级。
- 任务树内允许拖动改变父级，不支持在树中排序。
- 拖动父任务时子任务跟随，无需额外处理，因为子任务不参与列渲染。

列表：

- 看板只渲染当前层的任务，子任务折叠在任务内部，不在卡片列表中独立出现。

搜索：

- 搜索框固定在顶栏（面包屑右侧、主题控件左侧）；窄屏下可以收缩，主题控件不能被顶出视口。
- 关键词非空时，主区整块换成结果页，左侧任务树不动；清空关键词、按 Esc 或点「返回看板」回到原看板。
- 结果按列的固定顺序分组，空组不出现；每行是标题（命中片段高亮）、层级路径、工期（未估则不显示），归档结果另带标记。
- 输入停顿 200ms 才发请求；结果到达之前继续显示上一批，但界面上的高亮、计数与空状态文案都必须按「这批结果属于哪一次搜索」来说，不能拿输入框里的当前值去解释旧结果。
- 键盘 ↑ ↓ / Enter / Esc 在搜索框聚焦时生效；输入法组合期间（选字中）不接管任何按键。
- 从结果进入某个任务时清空搜索词：留着会让结果页盖住刚打开的那一层。
- 已归档任务是否参与匹配跟随「显示已归档」开关，与看板、任务树同一个开关。

主题：

- Tailwind 用 class 策略（`darkMode: 'class'`），在 `html` 元素上切换 `dark` 类。
- 主题偏好存 localStorage。首次访问跟随 `prefers-color-scheme`，用户手动切换后以本地偏好为准。

## 依赖图可视化

第三批已实现，界面与口径如下：

- 主区顶部有一行视图切换：「看板 / 依赖图」。搜索态下这一行不显示（结果页占满主区）。
- 依赖图是当前这一层的任务依赖图：按依赖深度自左向右分层，层内顺序与看板一致（列顺序 + 列内顺序）。
- 关键路径上的节点和边用强调色区分；每个任务标注工期、最早开始、最晚开始、松弛时间，松弛为 0 表示该任务在关键路径上。
- 点节点是选中，不是进入：右下角详情卡给出最早/最晚结束、列名与「进入看板」；点空白处或按 Esc 取消选中。
- 图可平移与缩放，并提供「适应窗口」。
- 「显示已归档」开关对图生效：关着时不显示归档节点与连着它的边；时间参数始终由后端按包含已归档任务的完整图计算，界面上要说明这一点。
- 布局不引入第三方图布局库：按拓扑序算最长路径分层，层内沿用看板顺序；不做交叉最小化。
- 图上的连线编辑不在本批范围：依赖仍只在任务详情抽屉里勾选。
