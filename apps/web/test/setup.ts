/**
 * 测试环境的统一设置。
 *
 * Testing Library 的 `findBy*` 与 `waitFor` 默认只等 1 秒。CI 的 runner 是 2 核，`pnpm -r test`
 * 又把 api（better-sqlite3 + 275 项）与 web（42 个 jsdom 环境）并行跑，1 秒在那种负载下会假红
 * ——审计报告 E4 记的就是这一类，措辞是「假红会掩盖真回归」。这里统一放到 3 秒：真挂住仍然会在
 * 3 秒失败，而正常路径（本地几十毫秒、CI 几百毫秒）一点都不受影响。
 *
 * 只调等待上限，不动 vitest 自己的 `testTimeout`（默认 5 秒）：多一个旋钮只会让人分不清是哪一层
 * 超时。
 */
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 3000 });
