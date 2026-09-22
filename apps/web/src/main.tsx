import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  // index.html 里一定有 #root，这里只是让类型收窄，顺便在模板被改坏时报错而不是白屏。
  throw new Error('index.html 缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
