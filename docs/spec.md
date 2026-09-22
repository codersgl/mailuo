# 任务看板规范

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
- 拖拽：跨列移动、同列内排序。
- 文件树导航：左侧树视图展示完整层级，可展开折叠，节点可拖动改变父级。
- 点击任务进入子看板，面包屑导航，接浏览器历史。
- 卡片显示直接子任务进度计数。
- 归档与取消归档。
- 深色模式。

### 第二批

- 任务描述编辑面板。
- 搜索。

### 第三批

- 任务依赖（DAG）。
- 工期录入。
- 关键路径计算与可视化。

### 明确排除

以下功能本版本不做，也不为它们预留结构。

- 账号登录、多用户、权限。
- 实时同步、WebSocket、离线支持。
- 卡片在列视图内跨层拖拽。跨层改父级只在文件树中进行。
- 每个看板自定义列。
- 截止日期、标签、附件、提醒。
- 移动端原生壳。

## 技术栈

- 前端：React + Vite，样式用 Tailwind CSS，响应式布局。
- 后端：TypeScript + Hono。
- 数据库：SQLite，驱动用 better-sqlite3，开启 `PRAGMA foreign_keys = ON`。
- 入参校验：Zod，经 `@hono/zod-validator` 做。

## 项目结构

```
KanBan/
  apps/web/                    React 前端
  apps/api/                    Hono 后端
    migrations/                SQL 迁移文件
  data/kanban.db               SQLite 文件，不入版本库
```

- 开发：Vite 跑 5173，`server.proxy` 把 `/api` 代理到后端 3000。
- 生产：Hono 提供 `/api/*`，并用 `serveStatic` 托管 `apps/web/dist`，只跑一个进程。
- 迁移：手写编号 SQL 文件，启动时按序执行，已执行的记录在 `schema_migrations` 表。

## 数据模型

```sql
CREATE TABLE columns (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  orders     INTEGER NOT NULL
);

CREATE TABLE tasks (
  id          TEXT    PRIMARY KEY,
  parent_id   TEXT    REFERENCES tasks(id),
  column_id   TEXT    NOT NULL REFERENCES columns(id),
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  duration    INTEGER NOT NULL DEFAULT 0,
  orders      INTEGER NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  archived_at TEXT
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
- `duration` 单位天，为 0 表示未估工期。
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
- 已归档任务默认不出现在看板列和文件树中。
- 文件树每一层提供"显示已归档"开关，默认关闭。开关状态只存在前端，不落库。

## 关键路径

- 按 CPM（关键路径法，Critical Path Method）实现：任务为顶点，依赖为有向边。
- 不引入 AOE 的事件顶点表。AOE 要求单源单汇，而个人规划中多起点多终点是常态。
- 计算过程：拓扑排序得到正向序，按正向序算出每个任务的最早开始时间；按反向序算出最晚开始时间；松弛时间 `slack = 最晚开始 - 最早开始`，`slack = 0` 的任务构成关键路径。
- 工期单位为天。工期为 0 的任务视为瞬时，不阻断关键路径传递，并在界面上提示未估工期。
- 计算结果不落库，每次读取时重算。依赖或工期一变缓存即失效，个人规模下重算成本可忽略。

## API 契约

| 方法   | 路径                       | 用途                       |
| ------ | -------------------------- | -------------------------- |
| GET    | `/api/board`               | 根看板                     |
| GET    | `/api/board/:parentId`     | 指定任务的子看板           |
| GET    | `/api/tree`                | 完整任务树（不含归档）     |
| GET    | `/api/breadcrumb/:taskId`  | 沿 parent_id 回溯的面包屑  |
| POST   | `/api/tasks`               | 新建任务                   |
| PATCH  | `/api/tasks/:id`           | 改标题、描述、工期，或移动 |
| PATCH  | `/api/tasks/:id/parent`    | 改父级（文件树拖动）       |
| PATCH  | `/api/tasks/:id/archive`   | 归档或取消归档             |
| DELETE | `/api/tasks/:id`           | 删除任务                   |
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

`GET /api/tree` 一次返回所有未归档任务的 `{ id, parentId, title, columnId }`，前端据此建树，展开时按需再取看板数据。树层级不深，个人规模下一次性返回比逐层懒加载简单。

`POST /api/tasks` 入参 `{ parentId, columnId, title }`。后端在同一父任务下取 `MAX(orders) + 1000` 作为新 `orders`，事务内完成。

`PATCH /api/tasks/:id` 移动入参 `{ columnId, position }`。后端重写目标列内所有任务的 `orders` 并返回该列任务列表。排序逻辑只存在于后端，前端不做本地重排。

`PATCH /api/tasks/:id/parent` 入参 `{ parentId, columnId }`。改动父级后，任务在新父级下追加到目标列末尾，`orders` 取新同级的 `MAX(orders) + 1000`。必须拒绝把任务挂到自己的后代下，否则会形成环，返回 `400`。

`PATCH /api/tasks/:id/archive` 入参 `{ archived: boolean }`。服务端按上述归档规则处理整棵子树。

`PUT /api/tasks/:id/deps` 入参 `{ predecessorIds: string[] }`，整体替换该任务的前置依赖。写入前做环检测和同层校验。

`DELETE /api/tasks/:id` 级联删除其所有后代任务，并删除这些任务作为任意一端的依赖记录。

错误统一返回 `{ error: string }`：`400` 入参非法，`404` 目标不存在，`409` 形成环。

## 界面行为

导航：

- 路由为 `/board/:taskId`，根看板为 `/`。
- 左侧文件树展示完整层级，展开折叠状态只存在前端本地存储，不落库。
- 文件树节点可拖动改变父级，走 `PATCH /api/tasks/:id/parent`。树的拖动是唯一允许跨层改父级的入口。
- 面包屑形如 `根看板 / 重构登录 / 前端部分`，每一段可点击返回上层。
- 面包屑导航写入浏览器历史，后退键行为与面包屑一致。
- 点击卡片主体进入该任务的看板。卡片角落的编辑入口打开侧边面板改标题、描述、归档。两者必须是不同的热区，避免编辑时误入下层。
- 空任务也允许进入，进入后是一个空看板。

拖拽：

- 列视图内允许跨列移动和同列排序，不允许跨层改父级。
- 文件树内允许拖动改变父级，不支持在树中排序。
- 拖动父任务时子任务跟随，无需额外处理，因为子任务不参与列渲染。

列表：

- 看板只渲染当前层的任务，子任务折叠在任务内部，不在卡片列表中独立出现。

主题：

- Tailwind 用 class 策略（`darkMode: 'class'`），在 `html` 元素上切换 `dark` 类。
- 主题偏好存 localStorage。首次访问跟随 `prefers-color-scheme`，用户手动切换后以本地偏好为准。

## 依赖图可视化

第三批实现，要求：

- 在同一层的看板上以有向图展示任务与依赖，关键路径上的节点和边用强调色区分。
- 每个任务标注最早开始、最晚开始、松弛时间。
- 布局库在实现该批次时选定，不在规范中锁定。
