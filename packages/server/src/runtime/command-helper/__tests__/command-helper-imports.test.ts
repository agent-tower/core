import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const entry = path.join(serverSource, 'runtime/command-helper/helper-main.ts');

// Runtime imports only: `import type` / `export type` are erased by tsc.
// A mixed `import { type A, b }` counts as a runtime import.
const STATEMENT = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?[^'";]*?from[ \t]*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT = /^[ \t]*import[ \t]+['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function importGraph(start: string): { modules: string[]; packages: string[] } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = [
      ...[...source.matchAll(STATEMENT)].filter((match) => !match[1]).map((match) => match[2]!),
      ...[...source.matchAll(SIDE_EFFECT)].map((match) => match[1]!),
      ...[...source.matchAll(DYNAMIC)].map((match) => match[1]!),
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')));
      else packages.add(specifier);
    }
  }
  return {
    modules: [...modules].map((file) => path.relative(serverSource, file).split(path.sep).join('/')).sort(),
    packages: [...packages].sort(),
  };
}

describe('command helper import graph', () => {
  it('stays small: Node built-ins, the owned-command runtime and the git state service only', () => {
    const { modules, packages } = importGraph(entry);
    // Adding a module here grows every helper process; Prisma, Fastify and
    // services must never appear (owned-child-process once reached Prisma
    // through acp/process-manager -> executors -> utils/index). The git state
    // service, its non-recursive watches and its file diffs (versions, diff,
    // cache) are the same code the server runs without a helper; views and
    // socket subscriptions stay in the server.
    expect(modules).toEqual([
      'git/state/git-file-diff.ts',
      'git/state/git-file-versions.ts',
      'git/state/git-repository-files.ts',
      'git/state/git-state-compute.ts',
      'git/state/git-state-limits.ts',
      'git/state/git-state-parsers.ts',
      'git/state/git-state-service.ts',
      'git/state/git-state-watches.ts',
      'runtime/acp/windows-process-tree.ts',
      'runtime/application-process-cleanup.ts',
      'runtime/command-helper/client.ts',
      'runtime/command-helper/helper-main.ts',
      'runtime/command-helper/protocol.ts',
      'runtime/errors.ts',
      'runtime/process-scope/process-scope.ts',
      'runtime/process-scope/scope-helper.ts',
      'runtime/runtime-metrics.ts',
      'runtime/shutdown-coordinator.ts',
      'utils/owned-child-process.ts',
      'utils/owned-process-limits.ts',
      'utils/process-launch.ts',
      'utils/unix-process-identity.ts',
    ]);
    expect(packages.filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
  });
});
