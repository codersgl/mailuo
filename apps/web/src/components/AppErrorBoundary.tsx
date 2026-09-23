import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { BrandMark } from './BrandMark';

/**
 * 整页错误兜底。
 *
 * 为什么必须有：React 在渲染期遇到未捕获的异常时会卸载整棵树，而 `main.tsx` 直接把 `<App />`
 * 挂上去，没有边界的话页面就是一片白、没有任何提示，只能靠用户猜（审计报告 C2）。
 * 触发条件并不罕见：后端 200 返回了形状不对的 JSON（代理被别的进程接管、后端版本不一致、
 * 后端 bug 返回 `{}`），渲染期访问 `board.columns.map` 之类的代码就会抛。
 *
 * 为什么是 class：错误边界只有 `getDerivedStateFromError` / `componentDidCatch` 这一种写法，
 * React 19 也没有函数组件版本。这个组件只做一件事：接住异常，显示一个可操作的页面。
 *
 * 形态取定版原型的 A2（居中卡片）：`main.tsx` 这一层没有应用外壳，所以兜底页自带整屏底色
 * 与一张 surface 卡片，视觉语言与看板卡片、抽屉一致。错误文本不上屏，只进控制台
 * ——普通用户看不懂它，反馈问题时控制台也拿得到。见 docs/decisions.md D58。
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 堆栈留在控制台：兜底页给的是「怎么恢复」，不是技术细节。控制台里仍要留痕，否则无从排查。
    console.error('界面渲染失败:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="grid min-h-screen place-items-center bg-canvas px-6 py-10">
        <section
          // role=alert：读屏用户也要在第一时间知道界面挂了，而不是以为页面还没加载完。
          role="alert"
          className="w-full max-w-[400px] rounded-[10px] border border-line bg-surface px-6 py-[22px]"
        >
          <div className="flex items-center gap-2">
            <BrandMark size={20} />
            <h1 className="text-[14px] font-semibold text-ink">界面出错了</h1>
          </div>
          <p className="mt-2 text-[12.5px] leading-[18px] text-ink-2">
            刚才那一步把界面弄坏了，可以重试；如果一直不行就刷新页面。任务数据在后端，不会因此丢失。
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              // 只丢掉错误状态重新渲染一次：数据在后端，重新取数通常就好了。
              onClick={() => this.setState({ error: null })}
              className="h-[26px] rounded-[5px] bg-accent px-2.5 text-[12px] text-on-fill hover:opacity-90"
            >
              重试
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="h-[26px] rounded-[5px] border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink"
            >
              刷新页面
            </button>
          </div>
        </section>
      </div>
    );
  }
}
