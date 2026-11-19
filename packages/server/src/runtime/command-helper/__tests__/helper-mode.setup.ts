/**
 * Vitest setup for `vitest.command-helper.config.ts`: runs a test file with
 * the command helper started, so every `runOwnedCommand` (git, CLI probes)
 * executes in the helper process. The file fails if any of them silently ran
 * in the test process instead.
 */
import { afterAll, beforeAll, expect } from 'vitest';
import { readRuntimeCounters, type RuntimeCounters } from '../../runtime-metrics.js';
import { startCommandHelper, stopCommandHelper } from '../client.js';

let before: RuntimeCounters;

beforeAll(async () => {
  if (!await startCommandHelper({ mode: 'on' })) throw new Error('The command helper did not start');
  before = readRuntimeCounters();
}, 60_000);

afterAll(async () => {
  const after = readRuntimeCounters();
  await stopCommandHelper();
  const viaHelper = after.commandsViaHelper - before.commandsViaHelper;
  const inProcess = after.commandsInProcess - before.commandsInProcess;
  console.info(`[helper mode] owned commands: helper=${viaHelper} in-process=${inProcess} helper-restarts=${after.helperRestarts - before.helperRestarts}`);
  expect(inProcess, 'owned commands ran in the test process although the helper was started').toBe(0);
}, 60_000);
