import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 后端端口与 apps/api 读同一个环境变量，避免两边漂移（见 docs/decisions.md D9）：
 * `PORT=3002 pnpm dev:api` 时，前端也要用 `PORT=3002 pnpm dev:web` 启动，代理才会跟着走。
 */
const apiPort = process.env.PORT ?? '3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 开发时由 Vite 把 /api 转发给后端，前端代码里只写相对路径，不需要关心端口。
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
