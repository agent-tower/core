import { describe, expect, it } from 'vitest';
import {
  MAX_TRANSLATION_BLOCK_BYTES,
  MAX_TRANSLATION_SEGMENT_BYTES,
  parseTranslationTemplate,
  prepareTranslation,
  renderTranslationTemplate,
  findTranslationParagraphEnds,
} from '../translation-protection.js';

const TOKENS = /⟦AT_[a-f0-9]{24}_\d+⟧/g;

describe('streaming translation paragraph boundaries', () => {
  it('seals complete paragraphs and groups short headings with prose, preserving CRLF', () => {
    const first = '# Heading\r\n\r\n' + 'Complete sentence. '.repeat(20) + '\r\n\r\n';
    const second = 'Another paragraph. '.repeat(20) + '\n\n';
    expect(findTranslationParagraphEnds(first + second + 'unfinished tail')).toEqual([first.length, first.length + second.length]);
    expect(findTranslationParagraphEnds('Unfinished paragraph. '.repeat(50))).toEqual([]);
  });

  it.each([
    ['```ts\n', '\n```'], ['~~~\n', '\n~~~'], ['<div>\n', '\n</div>'],
    ['<!--\n', '\n-->'], ['`', '`'], ['[label](https://example.test/', ')'],
    ['{"secret": "', '"}'],
  ])('does not seal inside a multiline protected construct beginning with %s', (open, close) => {
    const protectedText = open + 'secret '.repeat(50) + '\n\nprivate\n\n' + close;
    expect(findTranslationParagraphEnds(protectedText)).toEqual([]);
    expect(findTranslationParagraphEnds(protectedText + '\n\nnext')).toEqual([protectedText.length + 2]);
    expect(findTranslationParagraphEnds(open + 'secret '.repeat(50) + '\n\n')).toEqual([]);
  });
});

describe('translation templates', () => {
  it('parses only the two variables and substitutes source text exactly once', () => {
    const source = 'Hello {{text}} and {{target_language}}';
    expect(renderTranslationTemplate('To {{ target_language }}: {{ text }}', '简体中文', source))
      .toBe(`To 简体中文: ${source}`);
    expect(parseTranslationTemplate('{{text}} {{target_language}} {{text}}').filter((token) => token.type === 'variable')).toHaveLength(3);
  });

  it.each([
    '{{text}}', '{{target_language}}', '{{unknown}} {{text}} {{target_language}}',
    '{{ text }} {{ target_language }} {{ unfinished', '{{text}} {{target_language}} }}',
  ])('rejects missing, unknown or malformed variables: %s', (template) => {
    expect(() => parseTranslationTemplate(template)).toThrow('INVALID_TEMPLATE');
  });
});

describe('local translation protection', () => {
  it('keeps protected bytes local while translating link labels and natural language', () => {
    const original = [
      '# Hello',
      '',
      '- Read [the guide](https://secret.example/private?q=token "private title") and `const secret = "hidden"`.',
      '> Open /private/source.ts:12:4 with @Alice and ![private image caption](/private/image.png).',
      '[private-ref]: https://secret.example/reference "hidden reference title"',
      '::agent-download{file="output/private report.pdf"}',
      '::codex-inline-vis{file="private-panel.html"}',
      '<div data-token="private">private HTML text</div>',
      '```typescript',
      'const privateSource = "never send";',
      '```',
      '    private indented code',
      '',
    ].join('\r\n');
    const prepared = prepareTranslation(original);
    const outbound = prepared.segments.join('');
    expect(outbound).toContain('Hello');
    expect(outbound).toContain('the guide');
    for (const localValue of ['secret.example', 'private', 'hidden', '@Alice', 'const', 'agent-download', 'codex-inline-vis', '<div', 'typescript']) {
      expect(outbound).not.toContain(localValue);
    }
    const translated = prepared.segments.map((segment) => segment
      .replace('Hello', '你好').replace('Read', '阅读').replace('the guide', '指南').replace('Open', '打开'));
    expect(prepared.restore(translated)).toBe(original
      .replace('Hello', '你好').replace('Read', '阅读').replace('the guide', '指南').replace('Open', '打开'));
  });

  it.each([
    '```js\nconst secret = "never send";\n```',
    '~~~\nprivate code\n~~~',
    '    private indented code\n\tmore private code',
    '>     private indented quoted code',
    '-     private indented list code',
    '`private inline code`',
    '`private inline\ncode across lines`',
    'const secret = "private";',
    'console.log("private");',
    'pnpm exec private-command',
    '{\n  "private": "JSON value",\n  "nested": {"x": 1}\n}',
    '{\n "x": "}",\n "private": "private value"\n}',
    '[\n "closing ] in string",\n "private"\n]',
    '<div>private\n\nHTML block</div>',
    '<script>private\ncode\n</script>',
    '<!-- private\ncomment -->',
    '<div><!-- </div> -->private HTML text\nprivate continuation</div>',
    '<div><script>const fake = "</div>";</script>private HTML text</div>',
    '![private label](https://private.example/image.png)',
    '[private-reference]: https://private.example',
    '[private-reference]: https://private.example\n  "private title\ncontinued private title"',
    '![private\nimage](https://private.example)',
    '[private label](\nhttps://private.example/long path)',
    '[private label](https://private.example "private ) title\nprivate continuation")',
    '::agent-download{file="output/private.pdf"}',
    '::codex-inline-vis{file="private.html"}',
    'https://private.example/path',
    'C:\\private\\file.ts:12:3',
    '\\\\server\\private\\file.ts',
    './private/file.ts:12 ../private/file.ts /private/file.ts ~/private/file.ts src/private.ts private.ts',
    '"/private/a file.ts"',
    '@Alice @[private label](member-id)',
    '[private-label][] [private-shortcut]',
    '---\n123 456\n***',
  ])('does not send a protected-only block: %s', (original) => {
    const prepared = prepareTranslation(original);
    expect(prepared.hasTranslatableText).toBe(false);
    expect(prepared.segments).toEqual([]);
    expect(prepared.restore([])).toBe(original);
  });

  it('does not send incomplete code, HTML, image or link syntax it cannot safely identify', () => {
    for (const original of ['`private\nnever complete', '<div>private\nnever complete', '![private image', '[private label](private incomplete']) {
      const prepared = prepareTranslation(original);
      expect(prepared.segments.join('')).not.toContain('private');
      expect(prepared.restore(prepared.segments)).toBe(original);
    }
  });

  it('creates fresh, noncolliding tokens for each preparation and restores original token-like text literally', () => {
    const original = 'Hello `private` ⟦AT_aaaaaaaaaaaaaaaaaaaaaaaa_0⟧';
    const first = prepareTranslation(original);
    const second = prepareTranslation(original);
    expect(first.segments).not.toEqual(second.segments);
    expect(first.restore(first.segments)).toBe(original);
    expect(first.restore(second.segments)).toBe(second.segments.join(''));
  });

  it('accepts changed placeholders and surrounding text while restoring recognized placeholders', () => {
    const original = 'Hello `first` and `second`';
    const prepared = prepareTranslation(original);
    const segment = prepared.segments[0]!;
    const tokens = segment.match(TOKENS)!;
    const mutations: Array<[string, string]> = [
      [segment.replace(tokens[0]!, ''), 'Hello  and `second`'],
      [segment.replace(tokens[0]!, tokens[0]! + tokens[0]!), 'Hello `first``first` and `second`'],
      [segment.replace(tokens[0]!, 'TEMP').replace(tokens[1]!, tokens[0]!).replace('TEMP', tokens[1]!), 'Hello `second` and `first`'],
      [segment.replace(tokens[0]!, '⟦AT_aaaaaaaaaaaaaaaaaaaaaaaa_999⟧'), 'Hello ⟦AT_aaaaaaaaaaaaaaaaaaaaaaaa_999⟧ and `second`'],
      [`prologue ${segment}`, `prologue ${original}`],
      [`${segment} epilogue`, `${original} epilogue`],
      [` \n${segment}\n `, ` \n${original}\n `],
    ];
    for (const [result, expected] of mutations) expect(prepared.restore([result])).toBe(expected);
  });

  it('accepts Markdown structure changes across a restored delimiter', () => {
    const prepared = prepareTranslation('Hello#world');
    const translated = prepared.segments.map((segment) => segment.replace('Hello', '').replace('world', ' heading'));
    expect(prepared.restore(translated)).toBe('# heading');
    const comparison = prepareTranslation('Hello < private comparison >');
    expect(comparison.segments.join('')).not.toContain('private comparison');
  });

  it.each([
    '::agent-download{file="new.pdf"}', '::codex-inline-vis{file="new.html"}',
    '<img src=x>', '[new link](https://evil.example)', '![image](new.png)',
    'https://evil.example', 'javascript:alert', '/private/new', 'C:\\private\\new',
    '@NewMember', '`new code`', '**new bold**', '# heading', 'new\nline', 'www.evil.example', 'new.pdf',
  ])('preserves syntax returned by the translation service: %s', (translatedText) => {
    const prepared = prepareTranslation('Hello `private`');
    expect(prepared.restore(prepared.segments.map((segment) => segment.replace('Hello', translatedText))))
      .toBe(`${translatedText} \`private\``);
  });

  it.each([
    ['你好！', 'Hello!'],
    ['任务已经完成（成功）。', 'The task is done (successfully).'],
    ['例如，可以使用缓存。', 'Use caching, e.g. for repeated reads.'],
    ['请检查输入和输出。', 'Check input/output.'],
    ['第一行。第二行。', 'First line.\nSecond line.'],
    ['检查通过。', '✅'],
  ])('accepts translated punctuation and formatting for %s', (original, translated) => {
    const prepared = prepareTranslation(original);
    expect(prepared.restore([translated])).toBe(translated);
  });

  it('splits at Unicode code point boundaries, keeps requests bounded and restores in original index order', () => {
    const original = '汉字😀'.repeat(5000);
    const prepared = prepareTranslation(original);
    expect(prepared.segments.length).toBeGreaterThan(1);
    expect(prepared.segments.length).toBeLessThanOrEqual(16);
    for (const segment of prepared.segments) {
      expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(MAX_TRANSLATION_SEGMENT_BYTES);
      expect(segment).not.toContain('\uFFFD');
    }
    expect(prepared.restore(prepared.segments)).toBe(original);
  });

  it('admits exactly 64KiB plain text as sixteen requests and rejects excess without truncating', () => {
    const text = 'a'.repeat(MAX_TRANSLATION_BLOCK_BYTES);
    const prepared = prepareTranslation(text);
    expect(prepared.segments).toHaveLength(16);
    expect(prepared.restore(prepared.segments)).toBe(text);
    expect(() => prepareTranslation(text + 'a')).toThrow('PAYLOAD_TOO_LARGE');
    expect(() => prepareTranslation(('Hello *word* ').repeat(4600))).toThrow('PAYLOAD_TOO_LARGE');
  });
});
