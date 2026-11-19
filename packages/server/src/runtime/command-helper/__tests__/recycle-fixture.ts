import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCommandHelperEntry } from '../client.js';

/** Real helpers with a test-controlled ready gate and explicit periodic RSS samples. */
export function recycleFixture(directory: string) {
  const real = resolveCommandHelperEntry();
  const gate = path.join(directory, 'hold-ready');
  const candidate = path.join(directory, 'candidate.pid');
  const modulePath = path.join(directory, 'helper.mjs');
  fs.writeFileSync(modulePath, `
    import fs from 'node:fs';
    const gate = ${JSON.stringify(gate)};
    if (fs.existsSync(gate)) {
      fs.writeFileSync(${JSON.stringify(candidate)}, String(process.pid));
      await new Promise(resolve => {
        const watcher = fs.watch(${JSON.stringify(directory)}, check);
        function check() { if (!fs.existsSync(gate)) { watcher.close(); resolve(); } }
        check();
      });
    }
    process.on('message', message => {
      if (message.type !== 'run') return;
      const sample = /^test-rss-(\\d+)$/.exec(message.args.at(-1));
      if (sample) process.send({ type: 'stats', rssBytes: Number(sample[1]) * 1024 * 1024, running: 0 });
    });
    await import(${JSON.stringify(pathToFileURL(real.modulePath).href)});
  `);
  return { entry: { ...real, modulePath }, gate, candidate };
}

export function reportRssCommand(mb: number): [string, string[], { timeout: number }] {
  return [process.execPath, ['-e', '', `test-rss-${mb}`], { timeout: 10_000 }];
}
