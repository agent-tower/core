/** Finite real-socket acceptance run against the separately managed built server. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { configuration, repositoryRoot } from './common.mjs';

const config = configuration();
const marker = JSON.parse(fs.readFileSync(path.join(config.root, 'server.json'), 'utf8'));
assert.equal(marker.url, config.url, 'Use the port of the isolated smoke server');
assert.equal(marker.dataDir, config.dataDir);
process.kill(marker.pid, 0);
const serverRequire = createRequire(path.join(repositoryRoot, 'packages/server/package.json'));
const webRequire = createRequire(path.join(repositoryRoot, 'packages/web/package.json'));
const { PrismaClient } = serverRequire('@prisma/client');
const { io } = webRequire('socket.io-client');
const prisma = new PrismaClient({ datasources: { db: { url: `file:${path.join(config.dataDir, 'data.db')}` } } });
const token = fs.readFileSync(path.join(config.dataDir, 'internal-api-token'), 'utf8').trim();
const headers = { 'x-agent-tower-internal-token': token };
const fixture = fs.mkdtempSync(path.join(config.root, 'fixture-'));
const repo = path.join(fixture, 'repo');
const worktree = path.join(fixture, 'linked');
fs.mkdirSync(repo);
fs.writeFileSync(path.join(fixture, 'gitconfig'), '');
const gitEnv = { ...process.env, HOME: marker.homeDirectory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_CEILING_DIRECTORIES: fixture };
delete gitEnv.GIT_DIR;
delete gitEnv.GIT_WORK_TREE;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
// Git rooms follow the gateway's browser-owner convention. The disposable
// server disables its access password, so no internal/agent identity is sent.
const socket = io(`${config.url}/events`, { transports: ['websocket'], reconnection: false, autoConnect: false, timeout: 10_000 });
const pushes = [];
const ended = [];
socket.on('workspace:git_subscription_ended', message => ended.push(message));
socket.on('workspace:git_state', (payload) => pushes.push(payload));
let projectId;
let registered = false;
let fixtureRemoved = false;
const report = { status: 'FAIL', serverPid: marker.pid, url: config.url, checks: {} };

function observation() {
  return JSON.parse(fs.readFileSync(path.join(config.root, 'observation.json'), 'utf8'));
}
function waitForObservation(predicate, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      watcher.close();
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const inspect = () => {
      try { const value = observation(); if (predicate(value)) finish(null, value); }
      catch (error) { if (error.code !== 'ENOENT') finish(error); }
    };
    const watcher = fs.watch(config.root, (_event, filename) => { if (filename?.toString() === 'observation.json') inspect(); });
    const timer = setTimeout(() => finish(new Error('Timed out waiting for smoke telemetry')), timeout);
    watcher.on('error', (error) => finish(error));
    inspect();
  });
}
function waitForPush(predicate, timeout = 8_000) {
  const existing = pushes.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const listener = (value) => { if (predicate(value)) { clearTimeout(timer); socket.off('workspace:git_state', listener); resolve(value); } };
    const timer = setTimeout(() => { socket.off('workspace:git_state', listener); reject(new Error('Timed out waiting for git state push')); }, timeout);
    socket.on('workspace:git_state', listener);
  });
}
async function request(route) {
  const response = await fetch(`${config.url}/api${route}`, { headers, signal: AbortSignal.timeout(10_000) });
  assert(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
}
async function subscribe(workspaceId) {
  // A timed-out acknowledgement can still leave a server-side registration.
  // Cleanup must observe its release even when this request never answers.
  registered = true;
  const ack = await socket.timeout(15_000).emitWithAck('workspace-git:subscribe', { workspaceId });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.workspaceId, workspaceId);
  assert(ack.epoch && Number.isInteger(ack.version));
  assert.deepEqual(Object.keys(ack.state).sort(), ['baseBranch', 'changes', 'headOid', 'status']);
  return ack;
}

try {
  await request('/projects?limit=1');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Workspace Git Smoke');
  git(repo, 'config', 'user.email', 'workspace-git-smoke@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  // Provide the remote-ref directory watched by registered worktrees.
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'worktree', 'add', '-q', '-b', 'smoke-topic', worktree, 'main');
  const project = await prisma.project.create({ data: { name: 'Workspace Git Push Smoke', repoPath: repo, mainBranch: 'main', isGitRepo: true, worktreeReady: true } });
  projectId = project.id;
  async function workspace(title, directory, kind, branchName) {
    const task = await prisma.task.create({ data: { title, projectId, baseBranch: 'main' } });
    return prisma.workspace.create({ data: { taskId: task.id, branchName, baseBranch: 'main', workspaceKind: kind, worktreePath: directory, workingDir: directory } });
  }
  const linked = await workspace('Linked worktree', worktree, 'WORKTREE', 'smoke-topic');
  const mainA = await workspace('Main directory A', repo, 'MAIN_DIRECTORY', 'main');
  const mainB = await workspace('Main directory B', repo, 'MAIN_DIRECTORY', 'main');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
  const initial = await subscribe(linked.id);
  assert.equal(initial.state.headOid, git(worktree, 'rev-parse', 'HEAD'));
  assert.deepEqual(initial.state.changes, await request(`/git/changes?workingDir=${encodeURIComponent(worktree)}`));
  assert.deepEqual(initial.state.status, await request(`/workspaces/${linked.id}/git-status`));
  report.checks.acknowledgementMatchesRest = true;

  let active = initial;
  if (config.expectRecycle) {
    const beforeRecycle = observation();
    const oldPid = beforeRecycle.helper.pid;
    active = await waitForPush(value => value.workspaceId === linked.id && value.epoch !== initial.epoch, 110_000);
    const fresh = await waitForObservation(value => value.counters.helperRecycles === 1 && value.helper.pid !== oldPid);
    assert.equal(fresh.counters.helperRestarts, 0);
    assert.equal(fresh.counters.commandsInProcess, beforeRecycle.counters.commandsInProcess);
    assert.deepEqual(active.state, initial.state);
    assert.equal(pushes.filter(value => value.workspaceId === linked.id && value.epoch === active.epoch).length, 1);
    report.checks.recycle = { oldPid, newPid: fresh.helper.pid, oldEpoch: initial.epoch, newEpoch: active.epoch, initialVersion: active.version };
  }

  fs.appendFileSync(path.join(worktree, 'tracked.txt'), 'plain git commit\n');
  git(worktree, 'add', '.');
  const started = Date.now();
  git(worktree, 'commit', '-q', '-m', 'external commit observed through watch');
  const oid = git(worktree, 'rev-parse', 'HEAD');
  const changed = await waitForPush((value) => value.workspaceId === linked.id && value.state.headOid === oid);
  assert.equal(changed.epoch, active.epoch);
  assert(changed.version > active.version);
  if (config.expectRecycle) report.checks.recycle.pushedChange = { epoch: changed.epoch, version: changed.version, headOid: oid };
  report.checks.externalCommitPushMs = Date.now() - started;
  report.epoch = changed.epoch;
  const afterPushAt = Date.now();
  const beforeRest = await waitForObservation((value) => value.observedAt >= afterPushAt && value.counters.gitStatePushes >= 1 && value.counters.gitStateRegisteredWorktrees === 1);
  await request(`/workspaces/${linked.id}/git-status`);
  await request(`/git/changes?workingDir=${encodeURIComponent(worktree)}`);
  const afterRest = await waitForObservation((value) => value.counters.gitStateRequests >= beforeRest.counters.gitStateRequests + 2);
  assert.equal(afterRest.counters.gitStateGitProcesses, beforeRest.counters.gitStateGitProcesses);
  report.checks.registeredCleanRestGitProcesses = 0;

  await subscribe(mainA.id);
  await subscribe(mainB.id);
  await waitForObservation((value) => value.counters.gitStateRegisteredWorktrees === 2);
  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'main edit\n');
  socket.emit('workspace-git:refresh', { workspaceId: mainA.id });
  const mainPush = (id, additions) => (value) => value.workspaceId === id && value.state.changes.uncommitted.some((entry) => entry.path === 'tracked.txt' && entry.additions === additions);
  const [firstA, firstB] = await Promise.all([waitForPush(mainPush(mainA.id, 1)), waitForPush(mainPush(mainB.id, 1))]);
  assert.equal(firstA.epoch, firstB.epoch);
  assert.equal(firstA.version, firstB.version);
  assert.deepEqual(firstA.state.status, await request(`/workspaces/${mainA.id}/git-status`));
  assert.equal(firstA.state.status.hasUncommittedChanges, false);
  assert.deepEqual(firstA.state.changes, await request(`/git/changes?workingDir=${encodeURIComponent(repo)}`));
  socket.emit('workspace-git:unsubscribe', { workspaceId: mainA.id });
  const unsubscribedAt = Date.now();
  await waitForObservation((value) => value.observedAt >= unsubscribedAt + 10_300, 15_000);
  assert.equal(observation().counters.gitStateRegisteredWorktrees, 2);
  const aPushes = pushes.filter((value) => value.workspaceId === mainA.id).length;
  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'second main edit\n');
  socket.emit('workspace-git:refresh', { workspaceId: mainB.id });
  await waitForPush(mainPush(mainB.id, 2));
  assert.equal(pushes.filter((value) => value.workspaceId === mainA.id).length, aPushes);
  report.checks.mainDirectoryAliasesShareRegistration = true;
  report.checks.mainDirectoryStatusMatchesRest = true;
  report.helper = observation().helper;
  assert.deepEqual(ended, []);
  report.status = 'PASS';
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  const disconnectedAt = Date.now();
  socket.disconnect();
  try {
    if (registered) await waitForObservation((value) => value.observedAt >= disconnectedAt + 10_300 && value.counters.gitStateRegisteredWorktrees === 0, 15_000);
    if (projectId) await prisma.project.delete({ where: { id: projectId } });
    fs.rmSync(fixture, { recursive: true });
    fixtureRemoved = true;
  } catch (error) {
    report.cleanupError = String(error);
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  await prisma.$disconnect();
  report.fixtureRemoved = fixtureRemoved;
  try { report.finalObservation = observation(); }
  catch (error) { report.observationError = String(error); report.status = 'FAIL'; process.exitCode = 1; }
  fs.writeFileSync(path.join(config.root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
