import { defineConfig } from 'vitest/config';

/**
 * 测试环境用 jsdom：useBoard 的用例要真的挂载 React 组件（renderHook）。
 * 这里不引入 Tailwind 插件——测试不渲染真实样式。
 *
 * 覆盖率口径与 apps/api 一致（见那边的注释）：include 写死 `src/**`，让没被加载的文件也以
 * 0% 计入（入口 `main.tsx` 就是这样，它只做 createRoot + 挂载，没有对应的 jsdom 用例）；
 * 阈值取当前实测值向下取整再减 2 个点，调整时同步 docs/decisions.md D82。
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    // 统一抬高 Testing Library 的等待上限（为什么需要，见 test/setup.ts）。
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      thresholds: {
        statements: 89,
        branches: 86,
        functions: 91,
        lines: 91,
      },
    },
  },
});
