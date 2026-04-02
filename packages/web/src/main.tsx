import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { bootstrapTunnelSession } from './lib/tunnel-session'

async function start() {
  try {
    await bootstrapTunnelSession()
  } catch (error) {
    console.error('[Tunnel] Failed to bootstrap tunnel session', error)
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
