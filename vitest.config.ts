import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'packages/web/src'),
      '@agent-tower/shared/log-adapter': path.resolve(__dirname, 'packages/shared/src/log-adapter.ts'),
      '@agent-tower/shared/socket': path.resolve(__dirname, 'packages/shared/src/socket/index.ts'),
      '@agent-tower/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.{ts,tsx}'],
    server: {
      deps: {
        inline: ['@agent-tower/shared', 'fast-json-patch'],
      },
    },
  },
})
