import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  // index.html 里一定有 #root，这里只是让类型收窄。模板被改坏时这一次抛错发生在错误边界之外
  // （下面才挂载），页面仍然是白屏，但控制台里能直接看到「缺少 #root 挂载点」这条信息。
  throw new Error('index.html 缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    {/*
      边界放在最外层：任何渲染期异常都不该把页面变成白屏（见 docs/audit-2026-09-23.md 的 C2）。
      它包住整个 App 而不是某一块——白屏的代价比「整页换成一句说明 + 重试」大得多。
    */}
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
