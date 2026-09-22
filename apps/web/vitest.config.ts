import { defineConfig } from 'vitest/config';

/**
 * 测试环境用 jsdom：useBoard 的用例要真的挂载 React 组件（renderHook）。
 * 这里不引入 Tailwind 插件——测试不渲染真实样式。
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
  },
});
