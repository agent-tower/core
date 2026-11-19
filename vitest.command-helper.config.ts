import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

/**
 * Runs server suites with the command helper started, so owned commands
 * (`runOwnedCommand`: git, CLI probes) execute in the helper process:
 *
 *   npx vitest run --config vitest.command-helper.config.ts packages/server/src/git/worktree.manager.test.ts
 *
 * The default config keeps the in-process path. Do not pass the command
 * helper's own test files here; they start and stop helpers themselves.
 */
export default mergeConfig(base, defineConfig({
  test: {
    setupFiles: ['packages/server/src/runtime/command-helper/__tests__/helper-mode.setup.ts'],
  },
}))
