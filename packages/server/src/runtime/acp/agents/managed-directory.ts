import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface ManagedDirectory {
  path: string;
  cleanup(): Promise<void>;
}

export async function createManagedDirectory(
  name: string,
  files: Record<string, string>,
): Promise<ManagedDirectory> {
  const directory = await mkdtemp(path.join(tmpdir(), `agent-tower-${name}-`));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    await rm(directory, { recursive: true, force: true });
    // Mark only after rm succeeds so a transient filesystem failure can be
    // retried by the next cleanup attempt.
    cleaned = true;
  };

  try {
    await chmod(directory, 0o700);
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = path.resolve(directory, relativePath);
      if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) {
        throw new Error(`Managed ACP path escapes its directory: ${relativePath}`);
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { encoding: 'utf-8', mode: 0o600 });
      await chmod(target, 0o600);
    }
    return { path: directory, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
