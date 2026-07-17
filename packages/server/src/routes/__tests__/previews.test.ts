import { describe, expect, it } from 'vitest';
import type { NormalizedPreviewTarget } from '../../services/preview.service.js';
import {
  PREVIEW_SANDBOX_CSP,
  previewCorsHeaders,
  proxyRequestHeaders,
  proxyResponseHeaders,
  rewriteLocationHeader,
  rewritePreviewBody,
  rewriteSetCookieHeader,
} from '../previews.js';
import { buildPreviewPathPrefix, parsePreviewPath } from '../../utils/preview-path.js';

describe('rewritePreviewBody', () => {
  const workspaceId = 'workspace-1';
  const prefix = `/view/${workspaceId}`;
  const previewToken = 'pv1.d29ya3NwYWNlLTE.123.nonce.signature';
  const tokenPrefix = `/view/${workspaceId}/__agent_tower_preview/${previewToken}`;

  it('rewrites SPA router basename defaults without touching internal root path comparisons', () => {
    const body = [
      'function stripBasename(pathname, basename) {',
      '  if (basename === "/") return pathname;',
      '  return pathname;',
      '}',
      'function BrowserRouter({ basename = "/" }) {',
      '  return basename;',
      '}',
      'function Router({ basename: baseName = "/" }) {',
      '  return baseName;',
      '}',
      'function MinifiedRouter({basename:a="/"}){',
      '  return a;',
      '}',
      'let p=a.basename||"/";',
      'let ye=a.basename || "/";',
      'let fallback=a.basename??"/";',
      'let spaced=a.basename ?? "/";',
      'let root="/";',
    ].join('\n');

    const rewritten = rewritePreviewBody(body, workspaceId, 'application/javascript');

    expect(rewritten).toContain('basename === "/"');
    expect(rewritten).toContain(`basename = "${prefix}"`);
    expect(rewritten).toContain(`basename: baseName = "${prefix}"`);
    expect(rewritten).toContain(`basename:a="${prefix}"`);
    expect(rewritten).toContain(`p=a.basename||"${prefix}"`);
    expect(rewritten).toContain(`ye=a.basename || "${prefix}"`);
    expect(rewritten).toContain(`fallback=a.basename??"${prefix}"`);
    expect(rewritten).toContain(`spaced=a.basename ?? "${prefix}"`);
    expect(rewritten).toContain('root="/"');
    expect(rewritten).not.toContain(`${prefix}${prefix}`);
  });

  it('does not rewrite JavaScript endpoint fragments that are joined to an API base URL', () => {
    const body = 'const API_BASE_URL = "/api"; fetch(`${API_BASE_URL}${"/app-settings"}`);';

    const rewritten = rewritePreviewBody(body, workspaceId, 'application/javascript');

    expect(rewritten).toContain(`"${prefix}/api"`);
    expect(rewritten).toContain('"/app-settings"');
    expect(rewritten).not.toContain(`/api${prefix}/app-settings`);
  });

  it('rewrites JavaScript API and Socket.IO paths once without duplicating preview prefixes', () => {
    const body = [
      'fetch("/api/projects");',
      'const socketPath = "/socket.io/";',
      `const alreadyProxiedApi = "${prefix}/api/projects";`,
      `const alreadyProxiedSocket = "${prefix}/socket.io/";`,
    ].join('\n');

    const rewritten = rewritePreviewBody(body, workspaceId, 'application/javascript');

    expect(rewritten).toContain(`fetch("${prefix}/api/projects")`);
    expect(rewritten).toContain(`const socketPath = "${prefix}/socket.io/"`);
    expect(rewritten).toContain(`const alreadyProxiedApi = "${prefix}/api/projects"`);
    expect(rewritten).toContain(`const alreadyProxiedSocket = "${prefix}/socket.io/"`);
    expect(rewritten).not.toContain(`${prefix}${prefix}`);
    expect(rewritten).not.toContain(`${prefix}/socket.io${prefix}`);
  });

  it('rewrites preview API and WebSocket paths through the tokenized preview prefix', () => {
    const body = [
      'fetch("/api/echo");',
      'new WebSocket("/ws");',
      'const socketPath = "/socket.io/";',
    ].join('\n');

    const rewritten = rewritePreviewBody(body, workspaceId, 'application/javascript', previewToken);

    expect(rewritten).toContain(`fetch("${tokenPrefix}/api/echo")`);
    expect(rewritten).toContain(`new WebSocket("${tokenPrefix}/ws")`);
    expect(rewritten).toContain(`const socketPath = "${tokenPrefix}/socket.io/"`);
    expect(rewritten).not.toContain(`${tokenPrefix}${tokenPrefix}`);
  });

  it('still rewrites HTML and CSS absolute asset paths', () => {
    const html = '<script src="/assets/app.js"></script><link href="/styles/app.css" rel="stylesheet">';
    const css = 'body { background: url("/images/bg.png"); }';

    expect(rewritePreviewBody(html, workspaceId, 'text/html')).toContain(`${prefix}/assets/app.js`);
    expect(rewritePreviewBody(html, workspaceId, 'text/html')).toContain(`${prefix}/styles/app.css`);
    expect(rewritePreviewBody(css, workspaceId, 'text/css')).toContain(`url("${prefix}/images/bg.png")`);
  });

  it('injects the runtime bridge before target scripts for dynamic browser APIs', () => {
    const target: NormalizedPreviewTarget = {
      target: 'http://127.0.0.1:5173/app',
      origin: 'http://127.0.0.1:5173',
      basePath: '/app',
    };
    const html = '<html><head><script id="target-script">history.pushState({}, "", "/settings")</script></head></html>';

    const rewritten = rewritePreviewBody(html, workspaceId, 'text/html', null, target);

    expect(rewritten).toContain('data-agent-tower-preview-bridge');
    expect(rewritten).toContain('History.prototype.pushState');
    expect(rewritten).toContain('window.fetch =');
    expect(rewritten).toContain('window.WebSocket = PreviewWebSocket');
    expect(rewritten.indexOf('data-agent-tower-preview-bridge'))
      .toBeLessThan(rewritten.indexOf('id="target-script"'));
  });
});

describe('rewriteLocationHeader', () => {
  const workspaceId = 'workspace-1';
  const target: NormalizedPreviewTarget = {
    target: 'http://127.0.0.1:3000',
    origin: 'http://127.0.0.1:3000',
    basePath: '',
  };

  it('rewrites same-origin absolute paths into the preview prefix', () => {
    expect(rewriteLocationHeader('/foo?bar=1#section', workspaceId, target))
      .toBe('/view/workspace-1/foo?bar=1#section');
  });

  it('does not add the preview prefix twice', () => {
    expect(rewriteLocationHeader('/view/workspace-1/foo?bar=1#section', workspaceId, target))
      .toBe('/view/workspace-1/foo?bar=1#section');
  });

  it('does not rewrite external absolute locations even when their path starts with the preview prefix', () => {
    const external = 'https://example.com/view/workspace-1/foo?bar=1#section';

    expect(rewriteLocationHeader(external, workspaceId, target)).toBe(external);
  });

  it('rewrites same-origin locations into the tokenized preview prefix', () => {
    const token = 'pv1.d29ya3NwYWNlLTE.123.nonce.signature';

    expect(rewriteLocationHeader('/foo?bar=1#section', workspaceId, target, token))
      .toBe(`/view/workspace-1/__agent_tower_preview/${token}/foo?bar=1#section`);
  });
});

describe('parsePreviewPath', () => {
  it('parses legacy preview paths', () => {
    expect(parsePreviewPath('/view/workspace-1/api/echo?x=1')).toEqual({
      workspaceId: 'workspace-1',
      previewToken: null,
      suffix: '/api/echo',
      search: '?x=1',
    });
  });

  it('parses tokenized preview paths and removes the token marker from the proxy suffix', () => {
    const token = 'pv1.d29ya3NwYWNlLTE.123.nonce.signature';

    expect(parsePreviewPath(`/view/workspace-1/__agent_tower_preview/${token}/api/echo?x=1`)).toEqual({
      workspaceId: 'workspace-1',
      previewToken: token,
      suffix: '/api/echo',
      search: '?x=1',
    });
  });

  it('builds a tokenized prefix without treating normal app paths as tokens', () => {
    const token = 'pv1.d29ya3NwYWNlLTE.123.nonce.signature';

    expect(buildPreviewPathPrefix('workspace-1', token))
      .toBe(`/view/workspace-1/__agent_tower_preview/${token}`);
    expect(parsePreviewPath('/view/workspace-1/__agent_tower_preview/not-a-token/api')).toEqual({
      workspaceId: 'workspace-1',
      previewToken: null,
      suffix: '/__agent_tower_preview/not-a-token/api',
      search: '',
    });
  });
});

describe('proxyResponseHeaders', () => {
  const workspaceId = 'workspace-1';
  const target: NormalizedPreviewTarget = {
    target: 'http://127.0.0.1:3000',
    origin: 'http://127.0.0.1:3000',
    basePath: '',
  };

  it('adds a trusted sandbox CSP with same-origin browser storage enabled', () => {
    const headers = proxyResponseHeaders({
      'content-type': 'text/html',
      'content-security-policy': "default-src 'self'",
    }, workspaceId, target);

    expect(headers['content-security-policy']).toBe(PREVIEW_SANDBOX_CSP);
    expect(String(headers['content-security-policy'])).toContain('sandbox');
    expect(String(headers['content-security-policy'])).toContain('allow-same-origin');
    expect(headers['referrer-policy']).toBeUndefined();
  });

  it('does not forward preview target CORS policy and allows sandboxed preview resources to load', () => {
    const headers = proxyResponseHeaders({
      'access-control-allow-origin': 'http://127.0.0.1:3000',
      'access-control-allow-credentials': 'true',
      'cross-origin-resource-policy': 'same-origin',
    }, workspaceId, target, {
      'access-control-request-headers': 'content-type, x-preview-token',
    });

    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['access-control-allow-methods']).toContain('POST');
    expect(headers['access-control-allow-headers']).toBe('content-type, x-preview-token');
    expect(headers['access-control-allow-credentials']).toBeUndefined();
    expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('uses default CORS allow headers when a preview request has no preflight header list', () => {
    const headers = proxyResponseHeaders({}, workspaceId, target);

    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(String(headers['access-control-allow-headers'])).toContain('Content-Type');
    expect(headers.vary).toContain('Access-Control-Request-Headers');
  });
});

describe('trusted preview request headers', () => {
  it('maps browser origin and referer to the local target without forwarding Agent Tower cookies', () => {
    const targetUrl = new URL('http://127.0.0.1:5173');
    const headers = proxyRequestHeaders({
      host: 'tower.example.com',
      origin: 'https://tower.example.com',
      referer: 'https://tower.example.com/view/workspace-1/settings',
      cookie: 'agent-tower-access=secret; __Host-agent-tower-tunnel=tunnel; preview-session=abc',
    }, targetUrl, '/app/settings?tab=team');

    expect(headers.host).toBe('127.0.0.1:5173');
    expect(headers.origin).toBe('http://127.0.0.1:5173');
    expect(headers.referer).toBe('http://127.0.0.1:5173/app/settings?tab=team');
    expect(headers.cookie).toBe('preview-session=abc');
    expect(headers['x-forwarded-host']).toBe('127.0.0.1:5173');
    expect(headers['x-forwarded-proto']).toBe('http');
  });

  it('scopes target cookies to the workspace preview path and removes the target domain', () => {
    expect(rewriteSetCookieHeader(
      'preview-session=abc; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax',
      'workspace-1',
    )).toBe('preview-session=abc; Path=/view/workspace-1/; HttpOnly; SameSite=Lax');
  });
});

describe('previewCorsHeaders', () => {
  it('echoes requested preflight headers without enabling credentialed CORS', () => {
    const headers = previewCorsHeaders({
      origin: 'null',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-custom-header',
    });

    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['access-control-allow-methods']).toContain('POST');
    expect(headers['access-control-allow-headers']).toBe('content-type, x-custom-header');
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  });
});
