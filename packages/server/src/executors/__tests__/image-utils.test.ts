import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractImagePaths, parsePromptWithImages } from '../image-utils.js';

let dir: string;
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-image-whitespace-')); await fs.writeFile(path.join(dir, 'one.png'), 'image'); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('image encoding preserves literal text segments', () => {
  it('preserves whitespace-only segments before, between and after images, including missing-file fallback', async () => {
    const image = `![one](${path.join(dir, 'one.png')})`;
    const missing = `![missing](${path.join(dir, 'missing.png')})`;
    const result = await parsePromptWithImages(`  first\n${image}\n    \n${image}\nlast  \n${missing} \n`);
    expect(result.contentBlocks.filter(block => block.type === 'text').map(block => block.text)).toEqual(['  first\n', '\n    \n', '\nlast  \n', missing, ' \n']);
    expect(result.contentBlocks.filter(block => block.type === 'image')).toHaveLength(2);
  });

  it('Codex extraction removes only image syntax without trimming or collapsing newlines', async () => {
    const before = '    leading\n\n\ninside  \n'; const after = '\n   \n';
    const result = await extractImagePaths(`${before}![one](${path.join(dir, 'one.png')})${after}`);
    expect(result.textPrompt).toBe(before + after); expect(result.imagePaths).toEqual([path.join(dir, 'one.png')]);
  });
});
