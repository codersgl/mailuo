import { configDefaults, defineConfig } from 'vitest/config';

/**
 * api 的 vitest 配置。此前没有这份文件，测试跑在 vitest 的默认环境（node）下；这次只为覆盖率
 * 而加，没有改测试环境——不写 `environment` 就是默认的 node，别以为是漏配。
 *
 * 为什么显式写 include：不写时 v8 只统计「测试运行中被加载过的文件」，一个从没被 import
 * 的新模块会连 0% 都不显示，等于从分母里消失。写成 `src/**` 之后，入口 `src/index.ts`
 * 这类 vitest 不直接加载的文件也会以 0% 计入——这是事实：启动流程本身搬到了 `src/server.ts`
 * （100%，见 D85），`index.ts` 只剩组合根接线，由 `bin/mailuo.test.mjs` 的进程级用例真起服务
 * 跑过，而那种覆盖率算不进 vitest 的报告。宁可显示 0%，不要看不见。
 *
 * 阈值取当前实测值向下取整再减 2 个点：够拦住真实回退，又不会被无关的小重构因为小数点
 * 波动弄红。调这里的数要同步 docs/decisions.md D82 / D85 / D86。
 *
 * 2026-09-30（D85）：启动流程抽到 server.ts 之后实测 97.24 / 92.6 / 97.84 / 98.23。
 * server.ts 是 100 / 100 / 100 / 100；`index.ts` 0%，只剩组合根接线，未覆盖的函数是那 4 个
 * 真正需要包装的闭包（`os.networkInterfaces()`、`new Date()`、`db.close`、`process.on`）——
 * `console.*` / `process.exit` / `serve` 都是直接引用，不再各占一个未覆盖函数。
 *
 * 2026-09-30（D86）：补掉 13 条可达分支之后实测 98.12 / 95.13 / 97.84 / 98.48，
 * 语句与分支阈值跟着上调。剩下 25 条分支是构造上不可达的兜底（清单见 D86），不再强求。
 *
 * 2026-10-01（D92）：`apps/api` 的 vitest 与 `@vitest/coverage-v8` 钉在 4.1.11，是**有意的版本滞后**，
 * 不是漏升级。原因：`@stryker-mutator/vitest-runner@10.0.0` 在 vitest 5 下会选不出用例（每个变异体
 * 跑 0 条，全部记成存活），而在 4.1.11 下 perTest 完全正常——变异测试因此从 17–23 分钟降到约 5 分钟，
 * 覆盖率与 vitest 5 时期逐项相同。排查过程见 docs/decisions.md D91。
 *
 * **退出条件**：等 `@stryker-mutator/vitest-runner` 支持 vitest 5 之后，把这里的 vitest 与
 * `@vitest/coverage-v8` 升回 5.x、把这段注释删掉，并在 vitest 5 下重跑一遍变异测试确认 perTest
 * 仍然正确。在那之前不要单独升级这个包——升级会让变异门禁静默失效（分数照旧是个数，但全部是假存活）。
 */
export default defineConfig({
  test: {
    // Stryker 原地插桩时会把整份源码备份到 .stryker-tmp/，里面有测试文件的副本。
    // 不排掉的话 vitest 会把备份当成测试候选，跑起来找不到 migrations 目录而整份 dry run 崩掉
    // （`ENOENT: scandir '.../backup-XXXX/migrations'`，D88 与 D91 各踩过一次）。
    exclude: [...configDefaults.exclude, '**/.stryker-tmp*/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      // 测试挂了也要出报告：红的时候更需要知道是哪一块没跑到。
      reportOnFailure: true,
      thresholds: {
        statements: 96,
        branches: 93,
        functions: 95,
        lines: 96,
      },
    },
  },
});
