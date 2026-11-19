import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { RepositoryFingerprint } from './git-state-compute.js';

export type GitStateWatchFactory = (directory: string, onEvent: (filename: string | null) => void) => FSWatcher;

/** A few non-recursive git-directory watches; never watches working files. */
export class GitStateWatches {
  private readonly watches = new Map<string, { watcher: FSWatcher; names: Set<string> | null }>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly onEvent: () => void,
    private readonly createWatch: GitStateWatchFactory = (directory, listener) => watch(directory, { persistent: false }, (_event, filename) => listener(filename?.toString() ?? null)),
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  get size(): number { return this.watches.size; }

  update(fingerprint: RepositoryFingerprint | null): void {
    const targets = new Map<string, Set<string> | null>();
    if (fingerprint) {
      const { layout, refs } = fingerprint;
      targets.set(layout.gitDir, null);
      const addFile = (file: string) => {
        const directory = path.dirname(file);
        if (targets.has(directory) && targets.get(directory) === null) return;
        const names = targets.get(directory) ?? new Set<string>();
        names.add(path.basename(file));
        targets.set(directory, names);
      };
      addFile(path.join(layout.commonDir, 'packed-refs'));
      for (const ref of refs) addFile(path.join(layout.commonDir, ...ref.split('/')));
    }
    for (const [directory, entry] of this.watches) {
      if (!targets.has(directory)) {
        entry.watcher.close();
        this.watches.delete(directory);
      }
    }
    for (const [directory, names] of targets) {
      const existing = this.watches.get(directory);
      if (existing) {
        existing.names = names;
        continue;
      }
      try {
        const watcher = this.createWatch(directory, (filename) => {
          const entry = this.watches.get(directory);
          if (!entry || filename?.endsWith('.lock')) return;
          if (filename === null || entry.names === null || entry.names.has(filename)) this.onEvent();
        });
        this.watches.set(directory, { watcher, names });
        watcher.on('error', () => {
          if (this.watches.get(directory)?.watcher !== watcher) return;
          watcher.close();
          this.watches.delete(directory);
          this.warnOnce(directory);
        });
      } catch {
        this.warnOnce(directory);
      }
    }
  }

  close(): void {
    for (const { watcher } of this.watches.values()) watcher.close();
    this.watches.clear();
  }

  private warnOnce(directory: string): void {
    if (this.warned.has(directory)) return;
    this.warned.add(directory);
    this.log(`[git-state] Cannot watch ${directory}; the safety check will refresh its state`);
  }
}
