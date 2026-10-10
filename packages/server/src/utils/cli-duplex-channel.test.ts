import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createCliDuplexChannel, type CliDuplexEvent } from './cli-duplex-channel.js';
import { buildPtyCommandWithDuplex, buildPtyWrapperEnv } from './process-launch.js';

async function waitUntil(test: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!test() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  expect(test()).toBe(true);
}
describe('launch-scoped duplex transport', () => {
  it('waits for the late reader to consume result, usage and EOF before wrapper exit', async () => {
    const io = await createCliDuplexChannel();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-duplex-late-reader-'));
    const rootExit = path.join(dir, 'root-exit');
    const invocation = buildPtyCommandWithDuplex(process.execPath, ['-e', `process.stdout.write(JSON.stringify({type:'result',usage:{input_tokens:17,output_tokens:9}})+'\\n',()=>{require('node:fs').writeFileSync(process.argv[1],'done');process.exit(0);});`, rootExit], io.configFile);
    const child = spawn(invocation.command, invocation.args, { env: buildPtyWrapperEnv(process.env as Record<string, string>), stdio: 'ignore' });
    const exit = once(child, 'exit'); const events: CliDuplexEvent[] = [];
    try {
      await waitUntil(() => child.pid !== undefined);
      const deadline = Date.now() + 5000;
      while (!(await readFile(rootExit, 'utf8').catch(() => '')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      expect(await readFile(rootExit, 'utf8')).toBe('done');
      await new Promise(r => setTimeout(r, 350));
      expect(child.exitCode).toBeNull();
      io.subscribe(event => events.push(event));
      await exit;
      expect(child.exitCode).toBe(0);
      expect(events.flatMap(e => e.type === 'stdout' ? [e.data] : []).join('')).toContain('"usage":{"input_tokens":17,"output_tokens":9}');
      expect(events.at(-1)?.type).toBe('eof');
    } finally { io.close(); if (child.exitCode === null) { child.kill('SIGTERM'); await exit; } await rm(dir, { recursive: true, force: true }); }
  }, 10_000);

  it('drains backpressured output beyond 100ms and cleans a hung descendant before consumption ACK', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-duplex-backpressure-'));
    const endpoint = path.join(dir, 'io.sock'); const configFile = path.join(dir, 'launch.json');
    await writeFile(configFile, JSON.stringify({ endpoint, secret: 'test' }));
    let peer: Socket | undefined; let output = ''; let buffer = ''; let eof = false; let complete = false;
    let startedAt = 0; let consumedAt = 0;
    const server = createServer(socket => {
      peer = socket; socket.setEncoding('utf8');
      socket.on('data', data => {
        buffer += data;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
          if (frame.type === 'hello') {
            startedAt = Date.now(); socket.pause(); setTimeout(() => socket.resume(), 350);
          } else if (frame.type === 'stdout') output += frame.data;
          else if (frame.type === 'eof') eof = true;
          else if (frame.type === 'output_complete') complete = true;
        }
      });
    });
    await new Promise<void>(resolve => server.listen(endpoint, resolve));
    const payload = 'x'.repeat(4 * 1024 * 1024);
    const script = `const {spawn}=require('node:child_process');const grand=spawn(process.execPath,['-e',"process.on('SIGHUP',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});process.stdout.write('GRAND:'+grand.pid+'\\n');process.stdout.write('x'.repeat(4*1024*1024),()=>process.stdout.write('\\n'+JSON.stringify({type:'result',usage:{input_tokens:23,output_tokens:11}})+'\\n',()=>process.exit(0)));`;
    const invocation = buildPtyCommandWithDuplex(process.execPath, ['-e', script], configFile);
    const child = spawn(invocation.command, invocation.args, { env: buildPtyWrapperEnv(process.env as Record<string, string>), stdio: 'ignore' });
    const exit = once(child, 'exit');
    try {
      await waitUntil(() => complete, 10_000);
      consumedAt = Date.now();
      expect(consumedAt - startedAt).toBeGreaterThan(300);
      expect(eof).toBe(true);
      expect(output).toContain(payload + '\n{"type":"result","usage":{"input_tokens":23,"output_tokens":11}}\n');
      const pid = Number(/GRAND:(\d+)/.exec(output)?.[1]); expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(child.exitCode).toBeNull();
      peer!.write(JSON.stringify({ type: 'output_consumed' }) + '\n');
      await exit; expect(child.exitCode).toBe(0);
    } finally {
      peer?.destroy(); if (child.exitCode === null) { child.kill('SIGTERM'); await exit; }
      await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
  it('keeps real stdin open, separates Unicode stdout/stderr, serializes writes, and closes with EOF', async () => {
    const io = await createCliDuplexChannel(); const events: CliDuplexEvent[] = [];
    const script = `process.stdin.setEncoding('utf8'); let input=''; process.stdin.on('data', c=>{input+=c; process.stdout.write(c);}); process.stderr.write('诊断\\n'); process.stdin.on('end',()=>{process.stdout.write('EOF:'+input.length+'\\n');});`;
    const invocation = buildPtyCommandWithDuplex(process.execPath, ['-e', script], io.configFile);
    const child = spawn(invocation.command, invocation.args, { env: buildPtyWrapperEnv(process.env as Record<string, string>), stdio: 'ignore' });
    const exit = once(child, 'exit');
    const off = io.subscribe(event => events.push(event));
    try {
      await Promise.all([io.write('你好\n'), io.write('x'.repeat(100_000) + '\n'), io.write('last\n')]);
      await waitUntil(() => events.some(e => e.type === 'stdout' && e.data.includes('last')));
      expect(child.exitCode).toBeNull();
      await io.end(); await exit;
      const stdout = events.flatMap(e => e.type === 'stdout' ? [e.data] : []).join('');
      const stderr = events.flatMap(e => e.type === 'stderr' ? [e.data] : []).join('');
      expect(stdout).toContain('你好\n' + 'x'.repeat(100_000) + '\nlast\n');
      expect(stdout).not.toContain('诊断'); expect(stderr).toBe('诊断\n');
      expect(events.some(e => e.type === 'eof')).toBe(true);
      await expect(io.write('late')).rejects.toThrow();
    } finally { off(); io.close(); if (child.exitCode === null) { child.kill('SIGTERM'); await exit; } }
  }, 10_000);
  it('cleans a descendant retaining stdout after the native root exits', async () => {
    const io = await createCliDuplexChannel(); let output = '';
    const script = `const {spawn}=require('node:child_process'); const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); process.stdout.write('GRAND:'+grand.pid+'\\n'); setTimeout(()=>process.exit(0),50);`;
    const invocation = buildPtyCommandWithDuplex(process.execPath, ['-e', script], io.configFile);
    const child = spawn(invocation.command, invocation.args, { env: buildPtyWrapperEnv(process.env as Record<string, string>), stdio: 'ignore' });
    const exit = once(child, 'exit'); io.subscribe(event => { if (event.type === 'stdout') output += event.data; });
    try {
      await exit;
      const pid = Number(/GRAND:(\d+)/.exec(output)?.[1]); expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { io.close(); if (child.exitCode === null) { child.kill('SIGTERM'); await exit; } }
  }, 10_000);
  it('rejects queued writes invalidated before delivery and cleans the child on host disconnect', async () => {
    const io = await createCliDuplexChannel(); const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-duplex-test-'));
    const invocation = buildPtyCommandWithDuplex(process.execPath, ['-e', `process.stdin.resume(); setInterval(()=>{},1000);`], io.configFile);
    const child = spawn(invocation.command, invocation.args, { cwd: dir, env: buildPtyWrapperEnv(process.env as Record<string, string>), stdio: 'ignore' });
    const exit = once(child, 'exit'); io.subscribe(() => {});
    try {
      await io.write('first');
      await expect(io.write('cancelled', () => false)).rejects.toThrow('no longer active');
      io.close(); await exit; expect(child.exitCode).not.toBeNull();
    } finally { io.close(); if (child.exitCode === null) { child.kill('SIGTERM'); await exit; } await rm(dir, { recursive: true, force: true }); }
  }, 10_000);
});
