import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const executorDistDir = path.join(packageRoot, 'dist', 'executors');

mkdirSync(executorDistDir, { recursive: true });

for (const fileName of ['default-profiles.json', 'default-providers.json']) {
  cpSync(
    path.join(packageRoot, 'src', 'executors', fileName),
    path.join(executorDistDir, fileName)
  );
}
