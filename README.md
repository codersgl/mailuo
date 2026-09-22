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
pnpm dev:api          # 启动后端，默认 http://localhost:3000
pnpm test             # 跑测试
pnpm typecheck        # 类型检查
pnpm build            # 编译后端到 apps/api/dist
```

环境变量（都有默认值）：

- `PORT` 后端端口，默认 `3000`。若 3000 被占用，用 `PORT=3100 pnpm dev:api`，前端代理端口要与之一致。
- `KANBAN_DB_PATH` SQLite 文件路径，默认 `data/kanban.db`。

数据库在启动时自动建表并执行 `apps/api/migrations/` 下未应用过的迁移。
