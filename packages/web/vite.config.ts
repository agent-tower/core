import path from "path"
import type { ClientRequest, IncomingMessage } from 'node:http'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { getDevPort } from '@agent-tower/shared/dev-port'

const monorepoRoot = path.resolve(__dirname, '../..')
const backendPort = getDevPort(monorepoRoot)
const defaultBackendTarget = `http://localhost:${backendPort}`

function resolveBackendTarget(env: Record<string, string | undefined>): string {
  const configured = env.VITE_API_PROXY_TARGET
    || env.VITE_BACKEND_URL
    || env.VITE_API_URL
    || env.VITE_SOCKET_URL
  if (!configured) return defaultBackendTarget

  try {
    const url = new URL(configured)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return defaultBackendTarget
    }
    return url.origin
  } catch {
    return defaultBackendTarget
  }
}

function createProxy(target: string, ws = false): ProxyOptions {
  const targetOrigin = new URL(target).origin
  const rewriteOrigin = (proxyReq: ClientRequest, req: IncomingMessage) => {
    if (req.headers.origin) {
      proxyReq.setHeader('origin', targetOrigin)
    }
  }

  return {
    target,
    changeOrigin: true,
    ws,
    configure(proxy) {
      proxy.on('proxyReq', rewriteOrigin)
      proxy.on('proxyReqWs', rewriteOrigin)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, __dirname, ''), ...process.env }
  const backendTarget = resolveBackendTarget(env)

  return {
    plugins: [
      tailwindcss(),
      react(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      allowedHosts: ['.trycloudflare.com'],
      proxy: {
        '/api': createProxy(backendTarget),
        '/socket.io': createProxy(backendTarget, true),
        '/view': createProxy(backendTarget, true),
      },
    },
  }
})
