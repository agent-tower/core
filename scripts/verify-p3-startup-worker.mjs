import { verifyP3Startup } from './verify-cli-startup.mjs';

const [installedRoot, scratchDir] = process.argv.slice(2);
if (!installedRoot || !scratchDir) {
  throw new Error('Usage: node scripts/verify-p3-startup-worker.mjs <installed-root> <scratch-dir>');
}

console.log(await verifyP3Startup(installedRoot, scratchDir));
