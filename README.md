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

## 生产运行

```sh
pnpm build            # 后端编译到 apps/api/dist，前端打包到 apps/web/dist
pnpm start            # 只起一个进程：/api/* 是接口，其余路径由 apps/web/dist 托管
```

之后只访问 `http://127.0.0.1:3001` 即可（端口由 `PORT` 决定）。`/board/:taskId` 这类前端路由刷新时没有对应文件，会回落 `index.html`，交给前端自己解析；`/api/*` 的 404 仍是 JSON，不会变成一张页面。

顺序不能反：服务启动时只检查一次 `apps/web/dist/index.html` 在不在，所以**先 `pnpm build` 再 `pnpm start`**；跑着的时候重新构建不会当场生效，要重启。没构建过前端时启动日志会写明「本次只提供 API」，此时 `/` 返回 404 JSON，开发请用 `pnpm dev:web`。

缓存策略：`assets/` 下带内容哈希的文件长期缓存（`max-age=31536000, immutable`），`index.html` 与所有走 SPA 回退的路径不缓存（`no-cache`）——否则升级后浏览器拿旧 HTML 去请求已删除的旧哈希文件，页面会白屏。判定只看请求路径前缀，所以不要把不带哈希的文件放进 `apps/web/public/assets/`：它也会被缓存一年。

环境变量（都有默认值）：

- `PORT` 后端端口，默认 `3001`。被占用时在**仓库根目录**建 `.env` 写 `PORT=3003`：`pnpm dev:api` 与 `pnpm dev:web` 都读这个文件，Vite 的 `/api` 代理目标跟着走（见 `docs/decisions.md` D41）。
  - 根 `.env` 不入版本库（`.gitignore`），新克隆要自己建，每个 worktree 各一份；Vite dev server 自己的端口仍是 `5173`，改 `.env` 不影响它。
  - 改完 `.env` 要重启两个进程：`tsx watch` 不监听 `.env`。
  - 命令行前缀（例如 `PORT=3010 pnpm dev:api`）优先于 `.env`，适合临时试验；但只给一个进程加前缀会让两端不一致——后端换了端口、前端代理还指着旧端口，浏览器里表现为一直 404。
  - Vite 也会读这个文件，所以不要往里放 `VITE_*` 开头的敏感值（这类键会被内联进前端产物）。
- `HOST` 后端监听地址，默认 `127.0.0.1`，即**只服务本机**。接口没有鉴权（`docs/spec.md` 的「明确排除」不做账号系统），所以想让手机等其它设备访问时才设它，例如 `HOST=0.0.0.0`（所有网卡）或 `HOST=100.65.77.53`（某个具体地址）；设成非本机地址时启动日志会打印一条提醒（见 `docs/decisions.md` D55）。
  - 跨设备访问时，同网段（含 Tailscale）的设备都能读写全部任务，请自行确认这个网络是可信的。
  - Host/Origin 校验跟着这个值走：默认只接受回环主机名与本机网卡地址（后者在 `127.0.0.1` 下不可达，只是给 `0.0.0.0` 与将来经反向代理的场景用），用来挡 DNS rebinding（恶意页面把自己的域名解析到 `127.0.0.1` 后假装与 API 同源）；值留空会直接报错，不会静默回落默认值。
  - 若加了反向代理，注意保留原始 `Host`，否则这道校验会被代理改写掉。
  - 通配监听（`0.0.0.0`）时用 IP 访问（`http://192.168.1.5:3003`）直接可用；用机器名或 MagicDNS 名字访问要写进 `HOST_ALLOW`，否则直接访问时 Host 就被拒（读也 403），经 Vite 代理时读能通、写会 403（Origin 不在白名单）。
- `HOST_ALLOW` 额外放行的 Host 主机名，逗号分隔（例如 `HOST_ALLOW=sgl.local,sgl-1.tailnet.ts.net`）。只影响 Host/Origin 白名单，不改监听地址；不设时为空。IPv6 地址可以写裸形式（`fd7a::1`），也可以写 `[fd7a::1]:3003`。
- `KANBAN_DB_PATH` SQLite 文件路径，默认 `data/kanban.db`。

数据库在启动时自动建表并执行 `apps/api/migrations/` 下未应用过的迁移。

## 目录

- `apps/api` 后端：Hono + better-sqlite3，迁移在 `apps/api/migrations/`。
- `apps/web` 前端：React + Vite + Tailwind，设计令牌在 `apps/web/src/index.css` 的 `@theme`。
