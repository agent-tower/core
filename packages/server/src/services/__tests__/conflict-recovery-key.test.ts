import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-key-'));
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repo = path.join(dir, 'repo');
const loader = path.join(serverRoot, 'node_modules/tsx/dist/loader.mjs');
const run = promisify(execFile);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const code = `
import fs from 'node:fs/promises';
import path from 'node:path';
import { authorizeConflictResolutionContext, issueConflictResolutionContext, refreshConflictResolutionContext } from './src/services/conflict-resolution-context.ts';
const repo = process.env.CONFLICT_KEY_REPO;
const data = process.env.AGENT_TOWER_DATA_DIR;
const project = { repoPath: repo, createdAt: '2020-01-01', archivedAt: null };
const task = { id: 'task', projectId: 'project', createdAt: '2020-01-01', deletedAt: null, project };
const workspace = { id: 'workspace', status: 'ACTIVE', branchName: 'main', worktreePath: repo, createdAt: '2020-01-01', taskId: task.id, task };
const tx = { workspace: { findUnique: async () => workspace } };
const context = { projectId: 'project', sourceWorkspaceId: workspace.id, targetWorkspaceId: workspace.id, sourceWorkspaceBranch: 'main', sourceWorktreePath: repo, targetWorktreePath: repo, sourceBranch: 'side', targetBranch: 'main', conflictedFiles: ['file.txt'], conflictOp: 'MERGE', mergeAborted: false, mergeStrategy: 'no_ff' };
if (process.env.CONFLICT_KEY_PAUSE) {
  const link = fs.link.bind(fs);
  fs.link = async (...args) => {
    await fs.writeFile(path.join(data, 'ready'), 'ready');
    while (!await fs.stat(path.join(data, 'release')).then(() => true, () => false)) await new Promise(r => setTimeout(r, 5));
    return link(...args);
  };
}
try {
  const old = process.env.CONFLICT_KEY_TOKEN_FILE;
  const token = old ? await refreshConflictResolutionContext(tx, await fs.readFile(old, 'utf8'), 'workspace', 'owner') : await authorizeConflictResolutionContext(issueConflictResolutionContext(context), 'owner', tx);
  await fs.writeFile(process.env.CONFLICT_KEY_OUTPUT, token, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, recovery: JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).recovery }));
} catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, message: error.message })); }
`;
async function child(data: string, name: string, extra: Record<string, string> = {}) {
  const { stdout } = await run(process.execPath, ['--import', loader, '--input-type=module', '-e', code], {
    cwd: serverRoot, env: { ...process.env, AGENT_TOWER_DATA_DIR: data, CONFLICT_KEY_REPO: repo, CONFLICT_KEY_OUTPUT: path.join(data, name), ...extra }, timeout: 15000,
  });
  return JSON.parse(stdout.trim()) as { ok: boolean; recovery?: { keyId: string }; code?: string; message?: string };
}
async function until(file: string) { const end = Date.now() + 10000; while (!fs.existsSync(file)) { if (Date.now() > end) throw new Error('Child never reached publication'); await new Promise(r => setTimeout(r, 5)); } }
function dataDir() { return fs.mkdtempSync(path.join(dir, 'data-')); }

describe('private recovery key publication in real Node processes', () => {
  beforeAll(() => {
    fs.mkdirSync(repo); git('init', '-b', 'main'); git('config', 'user.email', 'key@example.test'); git('config', 'user.name', 'Key'); git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'base'); git('checkout', '-b', 'side');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'side\n'); git('commit', '-am', 'side'); git('checkout', 'main');
    fs.writeFileSync(path.join(repo, 'file.txt'), 'main\n'); git('commit', '-am', 'main');
    try { git('merge', '--no-ff', 'side'); } catch { /* real unmerged scene */ }
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('publishes one complete winner when two first creators race before atomic publication', async () => {
    const data = dataDir();
    const a = child(data, 'a', { CONFLICT_KEY_PAUSE: '1' });
    await until(path.join(data, 'ready'));
    expect(fs.existsSync(path.join(data, 'conflict-recovery-key'))).toBe(false);
    try {
      const b = await child(data, 'b'); expect(b.ok).toBe(true);
      expect(fs.readFileSync(path.join(data, 'conflict-recovery-key'))).toHaveLength(32);
      fs.writeFileSync(path.join(data, 'release'), 'go');
      const first = await a; expect(first.ok).toBe(true); expect(first.recovery?.keyId).toBe(b.recovery?.keyId);
      expect((await child(data, 'verified', { CONFLICT_KEY_TOKEN_FILE: path.join(data, 'a') })).ok).toBe(true);
      expect((await child(data, 'verified-b', { CONFLICT_KEY_TOKEN_FILE: path.join(data, 'b') })).ok).toBe(true);
    } finally { fs.writeFileSync(path.join(data, 'release'), 'go'); await a; }
  }, 30000);

  it.each(['empty', 'partial', 'public', 'unreadable', 'directory', 'symlink', 'fifo'])('explicitly rejects a %s final key without leaking filesystem details or issuing a normal token', async kind => {
    const data = dataDir(); const key = path.join(data, 'conflict-recovery-key');
    if (kind === 'directory') fs.mkdirSync(key);
    else if (kind === 'fifo') execFileSync('mkfifo', [key]);
    else if (kind === 'symlink') { const target = path.join(data, 'target'); fs.writeFileSync(target, Buffer.alloc(32), { mode: 0o600 }); fs.symlinkSync(target, key); }
    else fs.writeFileSync(key, Buffer.alloc(kind === 'empty' ? 0 : kind === 'partial' ? 13 : 32), { mode: kind === 'public' ? 0o644 : kind === 'unreadable' ? 0o000 : 0o600 });
    const result = await child(data, 'bad'); expect(result).toMatchObject({ ok: false, code: 'CONFLICT_RECOVERY_KEY_UNAVAILABLE' });
    expect(result.message).not.toContain(data); expect(fs.existsSync(path.join(data, 'bad'))).toBe(false);
  });

  it('survives a real creator process killed before publication without exposing its temporary file as a key', async () => {
    const data = dataDir();
    const process = spawn(globalThis.process.execPath, ['--import', loader, '--input-type=module', '-e', code], {
      cwd: serverRoot, env: { ...globalThis.process.env, AGENT_TOWER_DATA_DIR: data, CONFLICT_KEY_REPO: repo, CONFLICT_KEY_OUTPUT: path.join(data, 'interrupted'), CONFLICT_KEY_PAUSE: '1' }, stdio: 'ignore',
    });
    try {
      await until(path.join(data, 'ready'));
      const exited = new Promise(resolve => process.once('exit', resolve)); process.kill('SIGKILL'); await exited;
      expect(fs.existsSync(path.join(data, 'conflict-recovery-key'))).toBe(false);
      expect((await child(data, 'survivor')).ok).toBe(true);
      expect(fs.readFileSync(path.join(data, 'conflict-recovery-key'))).toHaveLength(32);
    } finally { process.kill('SIGKILL'); }
  });

  it('ignores interrupted unpublished temporary files and revokes proof on key replacement, including identical bytes', async () => {
    const data = dataDir(); fs.writeFileSync(path.join(data, 'conflict-recovery-key.interrupted.tmp'), Buffer.alloc(13), { mode: 0o600 });
    expect((await child(data, 'original')).ok).toBe(true);
    const key = path.join(data, 'conflict-recovery-key'); const material = fs.readFileSync(key);
    fs.renameSync(key, `${key}.old`); fs.writeFileSync(key, material, { mode: 0o600 });
    expect(await child(data, 'replaced', { CONFLICT_KEY_TOKEN_FILE: path.join(data, 'original') })).toMatchObject({ ok: false, code: 'CONFLICT_CONTEXT_INVALID' });
  });
});
