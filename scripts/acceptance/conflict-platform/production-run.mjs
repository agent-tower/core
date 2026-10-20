// Bounded production-path regressions. No persistent server or paid Provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runOwned } from './owned-command.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--([^=]+)=(.+)$/.exec(arg);
  if (!match) throw new Error('Use --name=value');
  return match.slice(1);
}));
for (const key of Object.keys(options)) if (!['suite', 'profile', 'case', 'kind', 'translation', 'iterations', 'out', 'mode'].includes(key)) throw new Error('UNKNOWN_OPTION');
const suite = options.suite ?? 'admission';
if (!['admission', 'route'].includes(suite)) throw new Error('INVALID_SUITE');
if (options.profile && options.profile !== 'production') throw new Error('INVALID_PROFILE');
const mode = options.mode ?? 'source';
if (!['source', 'full'].includes(mode)) throw new Error('INVALID_MODE');
const out = path.resolve(options.out ?? 'output/conflict-admission');
fs.mkdirSync(out, { recursive: true });
const provenance = Object.fromEntries([
  'packages/server/src/services/message-delivery.service.ts',
  'packages/server/src/services/conflict-admission.ts',
  'packages/server/src/git/worktree.manager.ts',
  'packages/server/src/utils/owned-child-process.ts',
  'packages/server/src/services/conflict-resolution-context.ts',
  'packages/server/src/git/git-cli.ts',
  ...['production-worker.test.ts', 'route-worker.test.ts', 'production-run.mjs', 'owned-command.mjs', 'vitest.config.ts'].map(file => `scripts/acceptance/conflict-platform/${file}`),
].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));

if (mode === 'full' || process.platform === 'win32') {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({
    qualification: 'NOT_RUN_NATIVE_ADMISSION', platform: process.platform, provenance,
    blockers: ['NATIVE_KEY_SCENE_OBSERVER_NOT_INTEGRATED', 'NATIVE_HELPER_COLD_RPC_NOT_CONNECTED'],
  }, null, 2));
  process.exitCode = 2;
} else {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), suite === 'route' ? 'tower-platform-' : 'tower-admission-'));
  const require = createRequire(path.join(root, 'package.json'));
  const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const results = [];
  let cleanupConfirmed = true;
  async function worker(file, fixture, env, reportName, timeout) {
    cleanupConfirmed = false; // A thrown launch/ownership error also retains the fixture.
    const processTree = await runOwned(process.execPath, [vitest, 'run', '--config', path.join(here, 'vitest.config.ts'),
      path.join(here, file), '--reporter=dot'], { cwd: root, timeout, env: { ...process.env, ...env } });
    cleanupConfirmed = processTree.cleanupConfirmed;
    const report = path.join(fixture, reportName);
    return { processTree, ...(fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : { status: 'FAILED_BEFORE_REPORT' }) };
  }
  try {
    if (suite === 'admission') {
      fs.mkdirSync(path.join(scratch, 'production'));
      for (const key of ['kind', 'translation', 'iterations']) if (options[key]) throw new Error('ROUTE_OPTION_REQUIRED');
      const result = await worker('production-worker.test.ts', scratch, {
        TOWER_ADMISSION_FIXTURE: path.join(scratch, 'production'), TOWER_ADMISSION_CASE: options.case ?? 'all',
      }, 'production/admission-report.json', 170_000);
      results.push(result);
      if (result.processTree.code !== 0 || result.status !== 'PASS_PRODUCTION_PATH') process.exitCode = 1;
    } else {
      const cases = options.case === 'all' ? ['restart', 'offline-rebuild', 'fast-rebuild', 'unstaged'] : [options.case ?? 'restart'];
      const kinds = options.kind === 'all' ? ['rebase', 'no_ff', 'squash'] : [options.kind ?? 'rebase'];
      if (cases.some(value => !['restart', 'offline-rebuild', 'fast-rebuild', 'unstaged'].includes(value))) throw new Error('INVALID_CASE');
      if (kinds.some(value => !['rebase', 'no_ff', 'squash'].includes(value))) throw new Error('INVALID_KIND');
      if (!['on', 'off'].includes(options.translation ?? 'on')) throw new Error('INVALID_TRANSLATION');
      const iterations = Number(options.iterations ?? 20);
      if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1000) throw new Error('INVALID_ITERATIONS');
      matrix: for (const scenario of cases) for (const kind of kinds) {
        const fixture = path.join(scratch, `${kind}-${scenario}`);
        fs.mkdirSync(fixture);
        const phases = [];
        for (const phase of ['issue', 'verify']) {
          const result = await worker('route-worker.test.ts', fixture, {
            TOWER_PLATFORM_FIXTURE: fixture, TOWER_PLATFORM_SCENARIO: scenario, TOWER_PLATFORM_KIND: kind,
            TOWER_PLATFORM_ITERATIONS: String(iterations), TOWER_PLATFORM_TRANSLATION: options.translation ?? 'on', TOWER_PLATFORM_PHASE: phase,
          }, `${phase}-report.json`, 120_000);
          phases.push({ phase, ...result });
          if (result.processTree.code !== 0 || result.status !== 'PASS') break;
        }
        const passed = phases.length === 2 && phases.every(item => item.processTree.code === 0 && item.status === 'PASS');
        results.push({ kind, scenario, status: passed ? 'PASS_SOURCE_SUBSET' : 'FAIL', phases });
        if (!passed) process.exitCode = 1;
        if (!cleanupConfirmed) break matrix;
      }
    }
  } catch (error) {
    process.exitCode = 1;
    throw error;
  } finally {
    if (cleanupConfirmed) fs.rmSync(scratch, { recursive: true, force: true });
    const report = { suite, status: results.length && !process.exitCode && cleanupConfirmed ? 'PASS' : 'FAIL',
      qualification: 'LOCAL_PRODUCTION_PATH_ONLY_NOT_WINDOWS_OR_35S_BUDGET_PASS',
      platform: process.platform, node: process.version, cleanupConfirmed, fixtureRetained: !cleanupConfirmed, provenance, results };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ suite, status: report.status, qualification: report.qualification, cleanupConfirmed }));
  }
}
