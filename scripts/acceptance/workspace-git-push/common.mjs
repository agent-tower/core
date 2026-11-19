import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function configuration() {
  const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
    if (argument === '--expect-recycle') return ['expectRecycle', true];
    const match = /^--(root|port|helper)=(.+)$/.exec(argument);
    assert(match, `Unknown argument: ${argument}; use --root=..., --port=..., --helper=on|off|auto`);
    return [match[1], match[2]];
  }));
  const root = path.resolve(repositoryRoot, options.root ?? '.tmp-step3a/workspace-git-push');
  // Also accept an existing private temporary directory for runs on a shared host.
  const inDirectory = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  let parent = repositoryRoot;
  if (!inDirectory(parent, root)) {
    parent = fs.realpathSync(process.env.TMPDIR ?? '/tmp');
    const stat = fs.statSync(parent);
    assert(inDirectory('/tmp', parent) && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, 'Use a private scratch TMPDIR under /tmp');
    assert(inDirectory(parent, root), 'Smoke data must stay inside the private TMPDIR');
  }
  // Check existing ancestors before creating directories through any symlink.
  let ancestor = root;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realParent = fs.realpathSync(parent);
  const realAncestor = fs.realpathSync(ancestor);
  assert(realAncestor === realParent || inDirectory(realParent, realAncestor), 'Smoke data cannot escape its root through a symlink');
  fs.mkdirSync(root, { recursive: true });
  assert(inDirectory(realParent, fs.realpathSync(root)), 'Choose a subdirectory for smoke data');
  const port = Number(options.port ?? 18483);
  assert(Number.isSafeInteger(port) && port > 1024 && port <= 65535 && port !== 12580, 'Choose a non-production localhost port');
  const helper = options.helper ?? 'on';
  assert(['on', 'off', 'auto'].includes(helper), 'Invalid helper mode');
  return { root, port, helper, expectRecycle: !!options.expectRecycle, dataDir: path.join(root, 'data'), url: `http://127.0.0.1:${port}` };
}
