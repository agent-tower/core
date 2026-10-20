import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export default defineConfig({
  root,
  resolve: { alias: {
    '@agent-tower/shared/log-adapter': path.join(root, 'packages/shared/src/log-adapter.ts'),
    '@agent-tower/shared/socket': path.join(root, 'packages/shared/src/socket/index.ts'),
    '@agent-tower/shared': path.join(root, 'packages/shared/src/index.ts'),
  } },
  test: {
    include: ['scripts/acceptance/conflict-platform/{production,route}-worker.test.ts'],
    maxWorkers: 1,
    pool: 'threads',
    testTimeout: 45_000,
    hookTimeout: 45_000,
    server: { deps: { inline: ['@agent-tower/shared', 'fast-json-patch'] } },
  },
});
