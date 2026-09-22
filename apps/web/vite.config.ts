import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 后端端口与 apps/api 同一个来源：仓库根目录的 .env（可选），见 docs/decisions.md D41。
 * 以前要求两个终端各带一次 `PORT=3003` 前缀，漏掉一个就会「后端正常、前端 404」。
 */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
try {
  // 与 apps/api/src/config.ts 的 loadEnvFileIfPresent 是同一套规则：文件不存在就跳过，
  // 已存在的环境变量（`PORT=3003 pnpm dev:web`）优先于文件里的值。
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }
}

const apiPort = process.env.PORT ?? '3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 开发时由 Vite 把 /api 转发给后端，前端代码里只写相对路径，不需要关心端口。
    port: 5173,
    // 5173 被占用时直接失败，而不是静默改用 5174。静默换端口会让人误判：
    // 旧进程还占着 5173，浏览器里那个标签连的是旧进程（代理目标可能还是上一个 PORT），
    // 于是刚改完端口却仍然 404。宁可启动报错，也不要一个看起来正常的错误页面。
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
