import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatErrorLogEntry, getErrorLogFilePath, getLogsDir, writeErrorLog } from './error-log.js';

const tempRoots: string[] = [];
const longAuthorizationPadding = 'x'.repeat(4200);

function makeTempRoot(): string {
  const root = path.join(os.tmpdir(), `agent-tower-error-log-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('error-log', () => {
  it('creates the logs directory and appends JSON log lines', () => {
    const dataDir = makeTempRoot();
    const logFile = writeErrorLog({
      level: 'error',
      source: 'test.source',
      message: 'Something failed',
      error: new Error('boom'),
      metadata: { sessionId: 'session-1' },
    }, {
      dataDir,
      now: new Date('2026-06-25T10:00:00.000Z'),
    });

    expect(logFile).toBe(getErrorLogFilePath(dataDir));
    expect(existsSync(getLogsDir(dataDir))).toBe(true);

    const parsed = JSON.parse(readFileSync(logFile!, 'utf-8').trim());
    expect(parsed).toMatchObject({
      time: '2026-06-25T10:00:00.000Z',
      level: 'error',
      source: 'test.source',
      message: 'Something failed',
      error: {
        name: 'Error',
        message: 'boom',
      },
      metadata: {
        sessionId: 'session-1',
      },
    });
  });

  it('redacts sensitive metadata keys and common token strings', () => {
    const line = formatErrorLogEntry({
      level: 'error',
      source: 'test.redaction',
      message: [
        'request failed authorization=Bearer fake-bearer-token',
        'OPENAI_API_KEY=fake-openai-key',
        'ANTHROPIC_AUTH_TOKEN=fake-anthropic-token',
        'access_token=fake-access-token',
        'provider-api-key=fake-provider-key',
        'CUSTOM_SECRET=fake-custom-secret',
      ].join('\n'),
      metadata: {
        apiKey: 'sk-1234567890abcdef',
        nested: {
          authToken: 'secret-token',
          safe: 'value',
        },
        output: 'stderr OPENAI_API_KEY=fake-output-key ANTHROPIC_AUTH_TOKEN=fake-output-token',
      },
    }, new Date('2026-06-25T10:00:00.000Z'));

    expect(line).not.toContain('sk-1234567890abcdef');
    expect(line).not.toContain('secret-token');
    expect(line).not.toContain('fake-bearer-token');
    expect(line).not.toContain('fake-openai-key');
    expect(line).not.toContain('fake-anthropic-token');
    expect(line).not.toContain('fake-access-token');
    expect(line).not.toContain('fake-provider-key');
    expect(line).not.toContain('fake-custom-secret');
    expect(line).not.toContain('fake-output-key');
    expect(line).not.toContain('fake-output-token');
    expect(line).toContain('[REDACTED]');
    const parsed = JSON.parse(line);
    expect(parsed.message).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(parsed.message).toContain('ANTHROPIC_AUTH_TOKEN=[REDACTED]');
    expect(parsed.message).toContain('access_token=[REDACTED]');
    expect(parsed.message).toContain('provider-api-key=[REDACTED]');
    expect(parsed.message).toContain('CUSTOM_SECRET=[REDACTED]');
    expect(parsed.metadata.output).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(parsed.metadata.output).toContain('ANTHROPIC_AUTH_TOKEN=[REDACTED]');
    expect(parsed.metadata.nested.safe).toBe('value');
  });

  it('redacts full authorization and cookie header values in free text', () => {
    const line = formatErrorLogEntry({
      level: 'error',
      source: 'test.header-redaction',
      message: [
        'request authorization: Bearer fake-auth-token fake-auth-extra',
        'cookie: session=fake-session; refresh=fake-refresh; theme=fake-theme',
      ].join('\n'),
      metadata: {
        output: [
          'stderr authorization=Basic fake-basic-token fake-basic-extra',
          'cookie=session=fake-output-session; refresh=fake-output-refresh',
        ].join('\n'),
      },
    }, new Date('2026-06-25T10:00:00.000Z'));

    expect(line).not.toContain('fake-auth-token');
    expect(line).not.toContain('fake-auth-extra');
    expect(line).not.toContain('fake-session');
    expect(line).not.toContain('fake-refresh');
    expect(line).not.toContain('fake-theme');
    expect(line).not.toContain('fake-basic-token');
    expect(line).not.toContain('fake-basic-extra');
    expect(line).not.toContain('fake-output-session');
    expect(line).not.toContain('fake-output-refresh');

    const parsed = JSON.parse(line);
    expect(parsed.message).toContain('authorization: [REDACTED]');
    expect(parsed.message).toContain('cookie: [REDACTED]');
    expect(parsed.metadata.output).toContain('authorization=[REDACTED]');
    expect(parsed.metadata.output).toContain('cookie=[REDACTED]');
  });

  it('redacts parameterized authorization headers through the full header value', () => {
    const line = formatErrorLogEntry({
      level: 'error',
      source: 'test.parameterized-authorization',
      message: [
        'authorization: Digest username=fake-digest-user, realm=fake-digest-realm, nonce=fake-digest-nonce, response=fake-digest-response',
        'authorization: AWS4-HMAC-SHA256 Credential=fake-aws-credential, SignedHeaders=host;x-date, Signature=fake-aws-signature',
      ].join('\n'),
      metadata: {
        output: [
          'authorization=Digest username=fake-output-user, response=fake-output-response',
          'authorization=AWS4-HMAC-SHA256 Credential=fake-output-credential, Signature=fake-output-signature',
        ].join('\n'),
      },
    }, new Date('2026-06-25T10:00:00.000Z'));

    expect(line).not.toContain('fake-digest-user');
    expect(line).not.toContain('fake-digest-realm');
    expect(line).not.toContain('fake-digest-nonce');
    expect(line).not.toContain('fake-digest-response');
    expect(line).not.toContain('fake-aws-credential');
    expect(line).not.toContain('fake-aws-signature');
    expect(line).not.toContain('fake-output-user');
    expect(line).not.toContain('fake-output-response');
    expect(line).not.toContain('fake-output-credential');
    expect(line).not.toContain('fake-output-signature');

    const parsed = JSON.parse(line);
    expect(parsed.message).toContain('authorization: [REDACTED]');
    expect(parsed.metadata.output).toContain('authorization=[REDACTED]');
  });

  it('redacts quoted authorization keys in JSON-like text', () => {
    const line = formatErrorLogEntry({
      level: 'error',
      source: 'test.quoted-authorization',
      message: [
        '{"authorization":"Digest username=fake-json-user, realm=fake-json-realm, nonce=fake-json-nonce, response=fake-json-response"}',
        '{"authorization":"AWS4-HMAC-SHA256 Credential=fake-json-credential, SignedHeaders=host;x-date, Signature=fake-json-signature"}',
      ].join('\n'),
      metadata: {
        output: [
          "'authorization':'Digest username=fake-output-user, response=fake-output-response'",
          "'authorization':'AWS4-HMAC-SHA256 Credential=fake-output-credential, Signature=fake-output-signature'",
        ].join('\n'),
      },
    }, new Date('2026-06-25T10:00:00.000Z'));

    expect(line).not.toContain('fake-json-user');
    expect(line).not.toContain('fake-json-realm');
    expect(line).not.toContain('fake-json-nonce');
    expect(line).not.toContain('fake-json-response');
    expect(line).not.toContain('fake-json-credential');
    expect(line).not.toContain('fake-json-signature');
    expect(line).not.toContain('fake-output-user');
    expect(line).not.toContain('fake-output-response');
    expect(line).not.toContain('fake-output-credential');
    expect(line).not.toContain('fake-output-signature');

    const parsed = JSON.parse(line);
    expect(parsed.message).toContain('"authorization":"[REDACTED]"');
    expect(parsed.metadata.output).toContain("'authorization':'[REDACTED]'");
  });

  it('redacts long quoted authorization values before truncating strings', () => {
    const line = formatErrorLogEntry({
      level: 'error',
      source: 'test.long-quoted-authorization',
      message: [
        `{"authorization":"Digest username=fake-long-json-user, response=fake-long-json-response, padding=${longAuthorizationPadding}"}`,
        `{"authorization":"AWS4-HMAC-SHA256 Credential=fake-long-json-credential, Signature=fake-long-json-signature, padding=${longAuthorizationPadding}"}`,
      ].join('\n'),
      metadata: {
        output: [
          `'authorization':'Digest username=fake-long-output-user, response=fake-long-output-response, padding=${longAuthorizationPadding}'`,
          `'authorization':'AWS4-HMAC-SHA256 Credential=fake-long-output-credential, Signature=fake-long-output-signature, padding=${longAuthorizationPadding}'`,
        ].join('\n'),
      },
    }, new Date('2026-06-25T10:00:00.000Z'));

    expect(line).not.toContain('fake-long-json-user');
    expect(line).not.toContain('fake-long-json-response');
    expect(line).not.toContain('fake-long-json-credential');
    expect(line).not.toContain('fake-long-json-signature');
    expect(line).not.toContain('fake-long-output-user');
    expect(line).not.toContain('fake-long-output-response');
    expect(line).not.toContain('fake-long-output-credential');
    expect(line).not.toContain('fake-long-output-signature');

    const parsed = JSON.parse(line);
    expect(parsed.message).toContain('"authorization":"[REDACTED]"');
    expect(parsed.metadata.output).toContain("'authorization':'[REDACTED]'");
  });

  it('redacts long escaped quoted authorization values before truncating strings', () => {
    const line = formatErrorLogEntry({
      level: 'error',
      source: 'test.long-escaped-quoted-authorization',
      message: [
        `{\\\"authorization\\\":\\\"Digest username=fake-escaped-json-user, response=fake-escaped-json-response, padding=${longAuthorizationPadding}\\\"}`,
        `{\\\"authorization\\\":\\\"AWS4-HMAC-SHA256 Credential=fake-escaped-json-credential, Signature=fake-escaped-json-signature, padding=${longAuthorizationPadding}\\\"}`,
      ].join('\n'),
      metadata: {
        output: [
          `\\'authorization\\':\\'Digest username=fake-escaped-output-user, response=fake-escaped-output-response, padding=${longAuthorizationPadding}\\'`,
          `\\'authorization\\':\\'AWS4-HMAC-SHA256 Credential=fake-escaped-output-credential, Signature=fake-escaped-output-signature, padding=${longAuthorizationPadding}\\'`,
        ].join('\n'),
      },
    }, new Date('2026-06-25T10:00:00.000Z'));

    expect(line).not.toContain('fake-escaped-json-user');
    expect(line).not.toContain('fake-escaped-json-response');
    expect(line).not.toContain('fake-escaped-json-credential');
    expect(line).not.toContain('fake-escaped-json-signature');
    expect(line).not.toContain('fake-escaped-output-user');
    expect(line).not.toContain('fake-escaped-output-response');
    expect(line).not.toContain('fake-escaped-output-credential');
    expect(line).not.toContain('fake-escaped-output-signature');

    const parsed = JSON.parse(line);
    expect(parsed.message).toContain('\\\"authorization\\\":\\\"[REDACTED]\\\"');
    expect(parsed.metadata.output).toContain("\\'authorization\\':\\'[REDACTED]\\'");
  });
});
