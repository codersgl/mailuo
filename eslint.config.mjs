// ESLint 扁平配置（ESLint 10）。`pnpm lint` 读这份文件，CI 也跑同一条命令。
//
// 规则范围刻意保守：只保留能指出真实缺陷的规则（未使用变量、未使用的导入、错误的 React
// Hooks 用法、圈复杂度回归等），不引入格式化与风格规则。风格问题交给 review，机器改写会
// 制造与本次改动无关的 diff。这里没有开类型感知（type-checked）规则集：那需要给解析器接
// 上 tsconfig 项目，收益（例如 no-floating-promises）值得另开一步单独评估。
//
// 关于 typescript 的两个版本（重要）：本仓库用 TypeScript 7（Go 原生编译器）做构建与
// 类型检查，而 typescript-eslint 8 只支持 TypeScript 6 的编译器 API
// （peer 声明 `>=4.8.4 <6.1.0`，遇到 7.0 直接抛错）。所以根 devDependencies 里的
// `typescript@^6` 只服务本文件，`apps/*` 各自的 `typescript@^7` 才是 `pnpm typecheck`
// 与 `pnpm build` 用的那个。升级 typescript-eslint 到支持 TS 7 的版本后，应删掉根上的
// typescript 6 依赖（见 docs/decisions.md D70）。

import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // 不扫生成的产物与本机临时目录。`.tmp-*` 是项目惯例里的验收/审阅临时目录
    // （见 .gitignore），它们里面常常有另一份完整代码副本。
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.worktrees/**',
      '.tmp-*/**',
      '.pnpm-store/**',
      'apps/web/public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // 未使用的参数用 `_` 前缀显式表示「签名需要、实现不用」（例如替身函数的
      // `(_frames, _options)`）。只放行参数，不放过未使用的变量与导入。
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // 后端、命令行、脚本与这份配置本身都在 Node 里跑。
  {
    files: [
      'eslint.config.mjs',
      'apps/api/**/*.ts',
      'bin/**/*.{mjs,mts}',
      'scripts/**/*.{mjs,mts}',
    ],
    languageOptions: { globals: { ...globals.node } },
  },

  // 前端跑在浏览器里，且是 React。
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // 只取经典的两条，不用 v7 的 `recommended`：后者把 React Compiler 的一组规则
      // 也算进来，其中 `react-hooks/refs`（render 期间写 ref）与
      // `react-hooks/set-state-in-effect` 会命中本仓库几处有意为之的写法
      // （usePointerDrag 的 latest-ref、useSearch 的空关键词重置，见 D61/D58）。
      // 那些写法正确性由用例钉住；换成编译器友好的写法是独立的一步，不在加门禁这一步里做。
      // `exhaustive-deps` 保留为 warning：5 条命中里 4 条是有意省略依赖或规则无法静态判断
      // （useAsync 的 deps 展开、只依赖 drag.begin、依赖对象 search 而列了 search.retry）；
      // 剩下 Sidebar 那条是真的可以按提示用 useMemo 收敛的性能气味，属于另一件事，不在本步处理。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 组件文件里混出非组件导出会让 HMR 整页面刷新；常量导出不在此列。
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // vite/vitest 配置与浏览器测试也跑在 Node 里。测试里用 renderHook 直接跑 hook，
  // 所以 hooks 规则同样挂上（实测无命中，是防回归）。
  {
    files: ['apps/web/*.config.ts', 'apps/web/test/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // 圈复杂度只对**产品代码**设门禁，不扫测试：测试替身（例如 App.test.tsx 里那个假后端
  // 路由函数，复杂度 73）天然是一大串分支，对它设限只会逼出无意义的拆分。
  // 阈值 30 的依据是当前最高值是 TreeNodeRow 的 26（见 D70 的测量），留一点余量；
  // 它的作用是挡住「再造一个更复杂的热点」，不是要求现在就把老热点拆掉。
  {
    files: ['apps/api/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}', 'bin/**/*.{mjs,mts}', 'scripts/**/*.{mjs,mts}'],
    rules: {
      complexity: ['error', 30],
    },
  },

  // 测试里用显式 any 构造替身与断言是惯用法，不算缺陷。
  // 非空断言不在这里放行：`tseslint.configs.recommended` 本来就没开这条规则
  // （它在 strict 里），写了 off 也只是个空操作。
  {
    files: ['apps/**/test/**/*.{ts,tsx}', 'bin/*.test.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
