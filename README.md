这是一个任务看板的网页端应用

## 技术栈

- 前端使用React + Vite
  - css使用**Tailwindcss**
  - 响应式布局
- 后端语言使用Typescript
- 数据库使用SQLite

## 项目定位

- 个人使用

## 本地运行

需要 Node 22 与 pnpm 11。

```sh
pnpm install          # 安装全部工作区依赖
pnpm dev:api          # 启动后端，默认 http://localhost:3001
pnpm dev:web          # 启动前端，默认 http://localhost:5173（需要后端同时在跑）
pnpm test             # 跑测试
pnpm typecheck        # 类型检查
pnpm build            # 编译后端到 apps/api/dist，打包前端到 apps/web/dist
```

开发时前端由 Vite 提供服务，`/api` 请求由 Vite 代理到后端，所以浏览器里只访问 5173 即可。

环境变量（都有默认值）：

- `PORT` 后端端口，默认 `3001`。被占用时在**仓库根目录**建 `.env` 写 `PORT=3003`：`pnpm dev:api` 与 `pnpm dev:web` 都读这个文件，Vite 的 `/api` 代理目标跟着走（见 `docs/decisions.md` D41）。
  - 根 `.env` 不入版本库（`.gitignore`），新克隆要自己建，每个 worktree 各一份；Vite dev server 自己的端口仍是 `5173`，改 `.env` 不影响它。
  - 改完 `.env` 要重启两个进程：`tsx watch` 不监听 `.env`。
  - 命令行前缀（例如 `PORT=3010 pnpm dev:api`）优先于 `.env`，适合临时试验；但只给一个进程加前缀会让两端不一致——后端换了端口、前端代理还指着旧端口，浏览器里表现为一直 404。
  - Vite 也会读这个文件，所以不要往里放 `VITE_*` 开头的敏感值（这类键会被内联进前端产物）。
- `KANBAN_DB_PATH` SQLite 文件路径，默认 `data/kanban.db`。

数据库在启动时自动建表并执行 `apps/api/migrations/` 下未应用过的迁移。

## 目录

- `apps/api` 后端：Hono + better-sqlite3，迁移在 `apps/api/migrations/`。
- `apps/web` 前端：React + Vite + Tailwind，设计令牌在 `apps/web/src/index.css` 的 `@theme`。
