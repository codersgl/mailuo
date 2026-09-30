import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * web 入口（src/main.tsx）的挂载冒烟。
 *
 * 为什么值得单独测：它是长期 0% 的两个入口之一（见 docs/decisions.md D82 / D83）。这里的性质与
 * api 的 `index.ts` 不同——那个由 bin 的进程级用例真起服务跑过，只是覆盖率算不进 vitest；
 * main.tsx 则是**真的没有任何用例执行它**。入口承担三件事：
 *
 * 1. `import './index.css'`：全局样式与主题令牌的唯一入口；
 * 2. 缺 `#root` 时立刻抛一条能看懂的错误，而不是静默白屏；
 * 3. 把 App 包在 AppErrorBoundary 里再挂载（渲染期异常不该白屏，见审计报告 C2）。
 *
 * 假的是 `createRoot`：jsdom 里真挂载 App 会触发一串 fetch，测到的是数据层而不是入口。所以这个
 * 文件证明的是**入口的控制流与元素结构**（挂到哪个容器、挂在什么树形里、缺挂载点时是否响亮
 * 失败），不证明真实挂载行为（StrictMode 双调用、生命周期）——那是 App.test.tsx 与
 * AppErrorBoundary.test.tsx 的事。第 1 件事（CSS import）这里也守不住：删掉那行 import，用例照样
 * 绿；要守它得对源码做断言（可选，本步没做）。
 */

const { createRootMock, renderMock } = vi.hoisted(() => ({
  createRootMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock('react-dom/client', () => ({ createRoot: createRootMock }));

createRootMock.mockReturnValue({ render: renderMock });

beforeEach(() => {
  /**
   * 入口靠 `import` 执行，模块只在第一次 import 时跑；每条用例都要一份新的模块注册表，否则
   * 上一条失败的那次 import 会以「已拒绝」的记录留在注册表里，下一条用例直接拿到同一个错误
   * ——用例结果就取决于声明顺序（乱序跑会假红）。
   */
  vi.resetModules();
  createRootMock.mockClear();
  renderMock.mockClear();
  document.body.innerHTML = '';
});

describe('main.tsx 挂载', () => {
  it('把 App 包在错误边界里挂到 #root', async () => {
    const container = document.createElement('div');
    container.id = 'root';
    document.body.appendChild(container);

    /**
     * 组件与入口必须来自**同一次**模块注册表：beforeEach 里 resetModules 之后，文件顶层的静态
     * import 已经作废，所以这里和 main.tsx 一样动态 import，才能比到同一个函数对象。
     */
    const { StrictMode } = await import('react');
    const { App } = await import('../src/App');
    const { AppErrorBoundary } = await import('../src/components/AppErrorBoundary');
    await import('../src/main');

    // times(1)：重复挂载（先 createRoot 再 createRoot(...).render）也要被拦下。
    expect(createRootMock).toHaveBeenCalledTimes(1);
    expect(createRootMock).toHaveBeenCalledWith(container);
    expect(renderMock).toHaveBeenCalledTimes(1);

    // 树形：StrictMode > AppErrorBoundary > App。边界在最外层，包住整个 App。
    const tree = renderMock.mock.calls[0]?.[0] as ReactElement<{ children: ReactElement }>;
    expect(tree.type).toBe(StrictMode);
    const boundary = tree.props.children as ReactElement<{ children: ReactElement }>;
    expect(boundary.type).toBe(AppErrorBoundary);
    // 有意钉死「App 是边界的直接子元素」：以后在两者之间插 Provider 时这里会红，届时显式改这条
    // 断言并把新的树形写清楚，而不是把它放宽成「子树里能找到 App」。
    expect(boundary.props.children.type).toBe(App);
  });

  it('没有 #root 时立刻抛出可读的错误，不起挂载', async () => {
    // 不造 #root：模拟 index.html 模板被改坏。
    await expect(import('../src/main')).rejects.toThrow('index.html 缺少 #root 挂载点');
    // getElementById 在 createRoot 之前，所以这一条必然成立；它防的是「先挂载后校验」的改写。
    expect(createRootMock).not.toHaveBeenCalled();
  });
});
