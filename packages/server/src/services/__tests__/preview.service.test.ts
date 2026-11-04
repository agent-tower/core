import { describe, expect, it } from 'vitest';
import { normalizePreviewTarget } from '../preview.service.js';

describe('normalizePreviewTarget', () => {
  it('accepts shorthand ports and loopback URLs', () => {
    expect(normalizePreviewTarget('3000').target).toBe('http://127.0.0.1:3000');
    expect(normalizePreviewTarget('localhost:5173').target).toBe('http://127.0.0.1:5173');
    expect(normalizePreviewTarget('http://[::1]:8080/app/').target).toBe('http://[::1]:8080/app');
    expect(normalizePreviewTarget('https://127.0.0.1:8443/dash').basePath).toBe('/dash');
  });

  it('normalizes wildcard listen addresses to loopback', () => {
    expect(normalizePreviewTarget('http://0.0.0.0:3000').target).toBe('http://127.0.0.1:3000');
  });

  it('accepts any host the Agent Tower server can reach', () => {
    expect(normalizePreviewTarget('192.168.1.20:8080').target).toBe('http://192.168.1.20:8080');
    expect(normalizePreviewTarget('http://api:4000/health').target).toBe('http://api:4000/health');
    expect(normalizePreviewTarget('https://Staging.Example.com').origin).toBe('https://staging.example.com');
  });

  it('rejects unsupported schemes and credentials', () => {
    expect(() => normalizePreviewTarget('ftp://127.0.0.1:21')).toThrow('must use http or https');
    expect(() => normalizePreviewTarget('http://user:pass@127.0.0.1:3000')).toThrow('credentials');
    expect(() => normalizePreviewTarget('   ')).toThrow('required');
  });

  it('rejects invalid ports', () => {
    expect(() => normalizePreviewTarget('http://127.0.0.1:70000')).toThrow();
    expect(() => normalizePreviewTarget('http://127.0.0.1:0')).toThrow();
  });
});
