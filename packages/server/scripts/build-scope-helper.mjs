#!/usr/bin/env node
/**
 * Builds the Linux scope supervisor (native/scope-helper/agent-tower-scope.c)
 * into prebuilds/linux-<arch>/agent-tower-scope as a static binary.
 *
 * Toolchains are tried in order: $AGENT_TOWER_SCOPE_CC, `zig cc` (cross-compiles
 * every target), a host C compiler (cc/gcc/clang), then Docker (alpine, musl).
 *
 * Usage: node scripts/build-scope-helper.mjs [--target linux-x64|linux-arm64] [--if-possible] [--force]
 *   --if-possible  exit 0 with a notice when no toolchain is available
 *                  (the server then runs process scopes in compatibility mode).
 *   --force        rebuild even when the binary is newer than the source.
 * The binary is written to a temporary name and renamed into place, so a
 * supervisor that is currently running keeps its old inode (no ETXTBSY).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(packageRoot, 'native', 'scope-helper', 'agent-tower-scope.c');
const args = process.argv.slice(2);
const ifPossible = args.includes('--if-possible');
const force = args.includes('--force');
const targetIndex = args.indexOf('--target');
const hostTarget = `${process.platform}-${process.arch}`;
const target = targetIndex >= 0 ? args[targetIndex + 1] : hostTarget;
const ZIG_TARGETS = { 'linux-x64': 'x86_64-linux-musl', 'linux-arm64': 'aarch64-linux-musl' };
const DOCKER_PLATFORMS = { 'linux-x64': 'linux/amd64', 'linux-arm64': 'linux/arm64' };

if (!ZIG_TARGETS[target]) {
  const message = `[scope-helper] no supervisor build for ${target}; process scopes use compatibility mode there`;
  if (ifPossible) { console.log(message); process.exit(0); }
  console.error(message);
  process.exit(1);
}

const outputDir = path.join(packageRoot, 'prebuilds', target);
const output = path.join(outputDir, 'agent-tower-scope');
const staging = `${output}.build-${process.pid}`;
mkdirSync(outputDir, { recursive: true });

if (!force && existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) {
  console.log(`[scope-helper] ${path.relative(packageRoot, output)} is up to date (use --force to rebuild)`);
  process.exit(0);
}

function available(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error;
}

function run(command, commandArgs, options = {}) {
  console.log(`[scope-helper] ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  return result.status === 0;
}

const attempts = [];
const customCc = process.env.AGENT_TOWER_SCOPE_CC;
if (customCc) {
  attempts.push(() => run(customCc, ['-O2', '-s', '-static', '-Wall', '-Wextra', '-o', staging, source]));
}
if (available('zig')) {
  attempts.push(() => run('zig', ['cc', '-target', ZIG_TARGETS[target], '-O2', '-s', '-static', '-Wall', '-Wextra', '-o', staging, source]));
}
if (target === hostTarget) {
  for (const cc of ['cc', 'gcc', 'clang']) {
    if (!available(cc)) continue;
    attempts.push(() => run(cc, ['-O2', '-s', '-static', '-Wall', '-Wextra', '-o', staging, source])
      || run(cc, ['-O2', '-s', '-Wall', '-Wextra', '-o', staging, source]));
  }
}
if (available('docker')) {
  attempts.push(() => run('docker', [
    'run', '--rm', '--platform', DOCKER_PLATFORMS[target],
    '-v', `${path.dirname(source)}:/src:ro`, '-v', `${outputDir}:/out`,
    'alpine:3.20', 'sh', '-c',
    `apk add --no-cache gcc musl-dev >/dev/null && gcc -O2 -s -static -Wall -Wextra -o /out/${path.basename(staging)} /src/agent-tower-scope.c`
      + (typeof process.getuid === 'function' ? ` && chown ${process.getuid()}:${process.getgid()} /out/${path.basename(staging)}` : ''),
  ]));
}

let built = false;
for (const attempt of attempts) {
  rmSync(staging, { force: true });
  if (attempt() && existsSync(staging)) { built = true; break; }
}
if (!built) {
  rmSync(staging, { force: true });
  const message = `[scope-helper] could not build ${target} supervisor (no zig/cc/docker toolchain succeeded)`;
  if (ifPossible) { console.log(message); process.exit(0); }
  console.error(message);
  process.exit(1);
}
try {
  chmodSync(staging, 0o755);
} catch (error) {
  // A container build may leave the file owned by another user; it is already executable then.
  if ((statSync(staging).mode & 0o111) === 0) throw error;
}
renameSync(staging, output);
console.log(`[scope-helper] built ${path.relative(packageRoot, output)} (${statSync(output).size} bytes)`);
