import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTunnelToken } from './lib/tunnel-token'

// 从 URL 提取隧道 token（如有），必须在 React 渲染前执行
initTunnelToken()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
