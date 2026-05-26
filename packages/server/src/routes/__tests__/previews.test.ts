import { describe, expect, it } from 'vitest';
import type { NormalizedPreviewTarget } from '../../services/preview.service.js';
import { rewriteLocationHeader, rewritePreviewBody } from '../previews.js';

describe('rewritePreviewBody', () => {
  const workspaceId = 'workspace-1';
  const prefix = `/view/${workspaceId}`;

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

  it('still rewrites HTML and CSS absolute asset paths', () => {
    const html = '<script src="/assets/app.js"></script><link href="/styles/app.css" rel="stylesheet">';
    const css = 'body { background: url("/images/bg.png"); }';

    expect(rewritePreviewBody(html, workspaceId, 'text/html')).toContain(`${prefix}/assets/app.js`);
    expect(rewritePreviewBody(html, workspaceId, 'text/html')).toContain(`${prefix}/styles/app.css`);
    expect(rewritePreviewBody(css, workspaceId, 'text/css')).toContain(`url("${prefix}/images/bg.png")`);
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
});
