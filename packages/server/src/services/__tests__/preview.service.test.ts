import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../errors.js';
import { normalizePreviewTarget } from '../preview.service.js';

describe('normalizePreviewTarget', () => {
  it('accepts shorthand ports and loopback URLs', () => {
    expect(normalizePreviewTarget('3000').target).toBe('http://127.0.0.1:3000');
    expect(normalizePreviewTarget('localhost:5173').target).toBe('http://127.0.0.1:5173');
    expect(normalizePreviewTarget('http://127.0.0.1:5173/app').target).toBe('http://127.0.0.1:5173/app');
    expect(normalizePreviewTarget('https://[::1]:8443').target).toBe('https://[::1]:8443');
  });

  it('normalizes 0.0.0.0 to 127.0.0.1', () => {
    expect(normalizePreviewTarget('0.0.0.0:3000').target).toBe('http://127.0.0.1:3000');
  });

  it('rejects non-loopback hosts', () => {
    expect(() => normalizePreviewTarget('http://example.com:3000')).toThrow(ServiceError);
    expect(() => normalizePreviewTarget('http://192.168.1.10:3000')).toThrow(ServiceError);
    expect(() => normalizePreviewTarget('http://169.254.169.254/latest/meta-data')).toThrow(ServiceError);
  });

  it('rejects unsupported schemes and credentials', () => {
    expect(() => normalizePreviewTarget('file:///tmp/index.html')).toThrow(ServiceError);
    expect(() => normalizePreviewTarget('ftp://localhost:2121')).toThrow(ServiceError);
    expect(() => normalizePreviewTarget('http://user:pass@localhost:3000')).toThrow(ServiceError);
  });

  it('rejects invalid ports', () => {
    expect(() => normalizePreviewTarget('localhost:0')).toThrow(ServiceError);
    expect(() => normalizePreviewTarget('localhost:70000')).toThrow(ServiceError);
  });
});
