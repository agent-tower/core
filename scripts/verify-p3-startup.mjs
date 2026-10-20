import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyP3Startup } from './verify-cli-startup.mjs';

// node scripts/verify-p3-startup.mjs SERVER_ROOT [cli|index|index-ts] [NODE] [WEB_DIR]
const [root, entryKind = 'cli', nodeExecutable = process.execPath, webDir] = process.argv.slice(2);
if (!root) throw new Error('Expected an isolated installation/server root');
const scratch = mkdtempSync(path.join(tmpdir(), 'tower-p3-startup-'));
try {
  console.log(await verifyP3Startup(path.resolve(root), scratch, { entryKind, nodeExecutable, webDir }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
