import { defineConfig } from 'vitest/config';

/**
 * 测试环境用 jsdom：useBoard 的用例要真的挂载 React 组件（renderHook）。
 * 这里不引入 Tailwind 插件——测试不渲染真实样式。
 *
 * 覆盖率口径与 apps/api 一致（见那边的注释）：include 写死 `src/**`，让没被加载的文件也以
 * 0% 计入。阈值取当前实测值向下取整再减 2 个点，调整时同步 docs/decisions.md D82。
 *
 * 2026-09-30（D83）补了卡片拖拽落点与 App 那几段拖拽回调的用例，实测
 * 95.42 / 91.14 / 95.94 / 97.58。余量只有 2 个点上下，而 `App.tsx` 自己就贴着全局语句阈值
 * （93.08 > 93）：在 App.tsx 里加一段没被跑到的代码，很可能直接压破门禁——改它之前先本地跑
 * 一次 `pnpm test:coverage`，把新分支一并补测。
 *
 * 2026-09-30（D84）补了入口 `main.tsx` 的挂载冒烟与新建行的 Esc 用例，实测
 * 95.91 / 91.4 / 96.39 / 98.09，函数与行阈值跟着上调。
 *
 * 2026-09-30（D87）补掉可达分支之后实测 97.15 / 95.65 / 96.84 / 98.38，语句阈值跟着上调。
 * 剩下的 49 条分支集中在 DependencyGraph（23）、TaskEditorPanel（11）与若干构造上不可达的兜底，
 * 清单见 D87。
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
        statements: 95,
        branches: 93,
        functions: 94,
        lines: 96,
      },
    },
  },
});
