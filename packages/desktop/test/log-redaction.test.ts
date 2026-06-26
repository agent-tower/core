import { describe, expect, it } from 'vitest';
import { redactDesktopLogText, sanitizeDesktopLogValue } from '../src/log-redaction.js';

const longAuthorizationPadding = 'x'.repeat(4200);

describe('desktop log redaction', () => {
  it('redacts prefixed sensitive keys in backend stdout and stderr tails', () => {
    const metadata = sanitizeDesktopLogValue({
      stdoutTail: 'OPENAI_API_KEY=fake-openai-key access_token=fake-access-token',
      stderrTail: 'ANTHROPIC_AUTH_TOKEN=fake-anthropic-token provider-secret=fake-provider-secret',
      safe: 'ok',
    }) as Record<string, string>;

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('fake-openai-key');
    expect(serialized).not.toContain('fake-access-token');
    expect(serialized).not.toContain('fake-anthropic-token');
    expect(serialized).not.toContain('fake-provider-secret');
    expect(metadata.stdoutTail).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(metadata.stdoutTail).toContain('access_token=[REDACTED]');
    expect(metadata.stderrTail).toContain('ANTHROPIC_AUTH_TOKEN=[REDACTED]');
    expect(metadata.stderrTail).toContain('provider-secret=[REDACTED]');
    expect(metadata.safe).toBe('ok');
  });

  it('redacts authorization and cookie assignments in free text', () => {
    const redacted = redactDesktopLogText(
      'authorization=Bearer fake-auth-token cookie=fake-cookie-value CUSTOM_TOKEN=fake-custom-token',
    );

    expect(redacted).not.toContain('fake-auth-token');
    expect(redacted).not.toContain('fake-cookie-value');
    expect(redacted).not.toContain('fake-custom-token');
    expect(redacted).toContain('authorization=[REDACTED]');
    expect(redacted).toContain('cookie=[REDACTED]');
    expect(redacted).toContain('CUSTOM_TOKEN=[REDACTED]');
  });

  it('redacts full authorization and cookie headers in backend output tails', () => {
    const metadata = sanitizeDesktopLogValue({
      stdoutTail: [
        'authorization: Bearer fake-stdout-auth fake-stdout-extra',
        'cookie: session=fake-stdout-session; refresh=fake-stdout-refresh',
      ].join('\n'),
      stderrTail: [
        'authorization=Basic fake-stderr-auth fake-stderr-extra',
        'cookie=session=fake-stderr-session; refresh=fake-stderr-refresh',
      ].join('\n'),
    }) as Record<string, string>;

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('fake-stdout-auth');
    expect(serialized).not.toContain('fake-stdout-extra');
    expect(serialized).not.toContain('fake-stdout-session');
    expect(serialized).not.toContain('fake-stdout-refresh');
    expect(serialized).not.toContain('fake-stderr-auth');
    expect(serialized).not.toContain('fake-stderr-extra');
    expect(serialized).not.toContain('fake-stderr-session');
    expect(serialized).not.toContain('fake-stderr-refresh');
    expect(metadata.stdoutTail).toContain('authorization: [REDACTED]');
    expect(metadata.stdoutTail).toContain('cookie: [REDACTED]');
    expect(metadata.stderrTail).toContain('authorization=[REDACTED]');
    expect(metadata.stderrTail).toContain('cookie=[REDACTED]');
  });

  it('keeps redacting later fields after a cookie header segment', () => {
    const redacted = redactDesktopLogText(
      'cookie=session=fake-cookie-session; refresh=fake-cookie-refresh CUSTOM_TOKEN=fake-custom-token',
    );

    expect(redacted).not.toContain('fake-cookie-session');
    expect(redacted).not.toContain('fake-cookie-refresh');
    expect(redacted).not.toContain('fake-custom-token');
    expect(redacted).toContain('cookie=[REDACTED]');
    expect(redacted).toContain('CUSTOM_TOKEN=[REDACTED]');
  });

  it('redacts parameterized authorization headers in backend output tails', () => {
    const metadata = sanitizeDesktopLogValue({
      stdoutTail: [
        'authorization: Digest username=fake-digest-user, realm=fake-digest-realm, nonce=fake-digest-nonce, response=fake-digest-response',
        'authorization: AWS4-HMAC-SHA256 Credential=fake-aws-credential, SignedHeaders=host;x-date, Signature=fake-aws-signature',
      ].join('\n'),
      stderrTail: [
        'authorization=Digest username=fake-stderr-digest-user, response=fake-stderr-digest-response',
        'authorization=AWS4-HMAC-SHA256 Credential=fake-stderr-aws-credential, Signature=fake-stderr-aws-signature',
      ].join('\n'),
    }) as Record<string, string>;

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('fake-digest-user');
    expect(serialized).not.toContain('fake-digest-realm');
    expect(serialized).not.toContain('fake-digest-nonce');
    expect(serialized).not.toContain('fake-digest-response');
    expect(serialized).not.toContain('fake-aws-credential');
    expect(serialized).not.toContain('fake-aws-signature');
    expect(serialized).not.toContain('fake-stderr-digest-user');
    expect(serialized).not.toContain('fake-stderr-digest-response');
    expect(serialized).not.toContain('fake-stderr-aws-credential');
    expect(serialized).not.toContain('fake-stderr-aws-signature');
    expect(metadata.stdoutTail).toContain('authorization: [REDACTED]');
    expect(metadata.stderrTail).toContain('authorization=[REDACTED]');
  });

  it('redacts quoted authorization keys in backend output tails', () => {
    const metadata = sanitizeDesktopLogValue({
      stdoutTail: [
        '{"authorization":"Digest username=fake-json-user, realm=fake-json-realm, nonce=fake-json-nonce, response=fake-json-response"}',
        '{"authorization":"AWS4-HMAC-SHA256 Credential=fake-json-credential, SignedHeaders=host;x-date, Signature=fake-json-signature"}',
      ].join('\n'),
      stderrTail: [
        "'authorization':'Digest username=fake-stderr-user, response=fake-stderr-response'",
        "'authorization':'AWS4-HMAC-SHA256 Credential=fake-stderr-credential, Signature=fake-stderr-signature'",
      ].join('\n'),
    }) as Record<string, string>;

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('fake-json-user');
    expect(serialized).not.toContain('fake-json-realm');
    expect(serialized).not.toContain('fake-json-nonce');
    expect(serialized).not.toContain('fake-json-response');
    expect(serialized).not.toContain('fake-json-credential');
    expect(serialized).not.toContain('fake-json-signature');
    expect(serialized).not.toContain('fake-stderr-user');
    expect(serialized).not.toContain('fake-stderr-response');
    expect(serialized).not.toContain('fake-stderr-credential');
    expect(serialized).not.toContain('fake-stderr-signature');
    expect(metadata.stdoutTail).toContain('"authorization":"[REDACTED]"');
    expect(metadata.stderrTail).toContain("'authorization':'[REDACTED]'");
  });

  it('redacts long quoted authorization values before truncating backend output tails', () => {
    const metadata = sanitizeDesktopLogValue({
      stdoutTail: [
        `{"authorization":"Digest username=fake-long-json-user, response=fake-long-json-response, padding=${longAuthorizationPadding}"}`,
        `{"authorization":"AWS4-HMAC-SHA256 Credential=fake-long-json-credential, Signature=fake-long-json-signature, padding=${longAuthorizationPadding}"}`,
      ].join('\n'),
      stderrTail: [
        `'authorization':'Digest username=fake-long-stderr-user, response=fake-long-stderr-response, padding=${longAuthorizationPadding}'`,
        `'authorization':'AWS4-HMAC-SHA256 Credential=fake-long-stderr-credential, Signature=fake-long-stderr-signature, padding=${longAuthorizationPadding}'`,
      ].join('\n'),
    }) as Record<string, string>;

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('fake-long-json-user');
    expect(serialized).not.toContain('fake-long-json-response');
    expect(serialized).not.toContain('fake-long-json-credential');
    expect(serialized).not.toContain('fake-long-json-signature');
    expect(serialized).not.toContain('fake-long-stderr-user');
    expect(serialized).not.toContain('fake-long-stderr-response');
    expect(serialized).not.toContain('fake-long-stderr-credential');
    expect(serialized).not.toContain('fake-long-stderr-signature');
    expect(metadata.stdoutTail).toContain('"authorization":"[REDACTED]"');
    expect(metadata.stderrTail).toContain("'authorization':'[REDACTED]'");
  });

  it('redacts long escaped quoted authorization values before truncating backend output tails', () => {
    const metadata = sanitizeDesktopLogValue({
      stdoutTail: [
        `{\\\"authorization\\\":\\\"Digest username=fake-escaped-json-user, response=fake-escaped-json-response, padding=${longAuthorizationPadding}\\\"}`,
        `{\\\"authorization\\\":\\\"AWS4-HMAC-SHA256 Credential=fake-escaped-json-credential, Signature=fake-escaped-json-signature, padding=${longAuthorizationPadding}\\\"}`,
      ].join('\n'),
      stderrTail: [
        `\\'authorization\\':\\'Digest username=fake-escaped-stderr-user, response=fake-escaped-stderr-response, padding=${longAuthorizationPadding}\\'`,
        `\\'authorization\\':\\'AWS4-HMAC-SHA256 Credential=fake-escaped-stderr-credential, Signature=fake-escaped-stderr-signature, padding=${longAuthorizationPadding}\\'`,
      ].join('\n'),
    }) as Record<string, string>;

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('fake-escaped-json-user');
    expect(serialized).not.toContain('fake-escaped-json-response');
    expect(serialized).not.toContain('fake-escaped-json-credential');
    expect(serialized).not.toContain('fake-escaped-json-signature');
    expect(serialized).not.toContain('fake-escaped-stderr-user');
    expect(serialized).not.toContain('fake-escaped-stderr-response');
    expect(serialized).not.toContain('fake-escaped-stderr-credential');
    expect(serialized).not.toContain('fake-escaped-stderr-signature');
    expect(metadata.stdoutTail).toContain('\\\"authorization\\\":\\\"[REDACTED]\\\"');
    expect(metadata.stderrTail).toContain("\\'authorization\\':\\'[REDACTED]\\'");
  });
});
