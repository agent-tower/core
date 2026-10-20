import path from 'node:path'

// Run Vitest from the fixed export; product imports never resolve through the
// checkout containing this harness when ROOM_SOCKET_EXECUTION_ROOT is supplied.
const execution = path.resolve(process.env.ROOM_SOCKET_EXECUTION_ROOT ?? path.join(import.meta.dirname, '../../..'))
export default {
  root: execution,
  resolve: { alias: {
    '@probe/server': path.join(execution, 'packages/server/src'),
    '@probe/socket-io': path.join(execution, 'packages/server/node_modules/socket.io/dist/index.js'),
    '@probe/socket-io-client': path.join(execution, 'packages/web/node_modules/socket.io-client/build/esm/index.js'),
    '@agent-tower/shared/log-adapter': path.join(execution, 'packages/shared/src/log-adapter.ts'),
    '@agent-tower/shared/socket': path.join(execution, 'packages/shared/src/socket/index.ts'),
    '@agent-tower/shared': path.join(execution, 'packages/shared/src/index.ts'),
    'vitest': path.join(execution, 'node_modules/vitest/dist/index.js'),
  } },
  test: {
    include: [path.join(import.meta.dirname, '*.test.ts')],
    maxWorkers: 1,
    fileParallelism: false,
    server: { deps: { inline: ['@agent-tower/shared', 'fast-json-patch'] } },
  },
}
