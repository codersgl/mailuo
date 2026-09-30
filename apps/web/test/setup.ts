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

/**
 * jsdom 没有 Web Animations API：`Element.prototype.getAnimations` 与 `animate` 都是 undefined。
 * 看板卡片的让位动画（hooks/useCardFlip）在拖拽期间会先取消上一轮动画，也就是调用容器的
 * `getAnimations`；不补的话，任何在 App 层真的把卡片拖起来的用例都会 TypeError。
 *
 * 两个补丁的地位不同，别把它们当成等价的：
 * - `getAnimations`（必需）：返回空数组就是「没有上一轮动画」，这正是 App 层拖拽用例要的状态。
 * - `animate`（契约占位）：jsdom 里卡片矩形恒为 0，让位动画的 dx/dy 也是 0，所以 App 层根本走不到
 *   `card.animate`；这里只是补全 API 形状。返回的对象只有 `cancel`，用不到 `finished` / `playState`。
 *   将来生产代码若依赖这些字段，先把这个 stub 补真，否则 App 层会静默通过、浏览器里才炸。
 *
 * 动画本身对不对，仍由 useCardFlip.test.tsx 的元素级替身与浏览器验收负责（那个文件给每张卡片
 * 单独装 animate，实例属性会盖住这里的原型默认值）。
 *
 * 注意这里**不补** `document.elementFromPoint`：哪些用例需要「指针压在哪」是逐条的语义选择，
 * 由用例自己在 before/after 里装卸（dropSlot.test.ts、App.test.tsx、Sidebar.test.tsx）。
 *
 * 包一层 `typeof Element`：setupFiles 对所有测试文件生效，而 viteConfig.test.ts 跑在 node 环境
 * 下（没有 DOM，直接写 `Element.prototype` 会 ReferenceError 整个套件）。
 */
if (typeof Element !== 'undefined') {
  if (typeof Element.prototype.getAnimations !== 'function') {
    Element.prototype.getAnimations = () => [];
  }
  if (typeof Element.prototype.animate !== 'function') {
    Element.prototype.animate = () => ({ cancel() {} }) as unknown as Animation;
  }
}
