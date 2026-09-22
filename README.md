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

- `PORT` 后端端口，默认 `3001`。被占用时用 `PORT=3002 pnpm dev:api`；前端启动时也要传同一个值（`PORT=3002 pnpm dev:web`），代理目标跟着走。
- `KANBAN_DB_PATH` SQLite 文件路径，默认 `data/kanban.db`。

数据库在启动时自动建表并执行 `apps/api/migrations/` 下未应用过的迁移。

## 目录

- `apps/api` 后端：Hono + better-sqlite3，迁移在 `apps/api/migrations/`。
- `apps/web` 前端：React + Vite + Tailwind，设计令牌在 `apps/web/src/index.css` 的 `@theme`。
