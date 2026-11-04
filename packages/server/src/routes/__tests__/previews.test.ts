import { describe, expect, it } from 'vitest';
import type { NormalizedPreviewTarget } from '../../services/preview.service.js';
import {
  buildPreviewBootstrapPage,
  buildPreviewBridgeScript,
  buildPreviewServiceWorkerScript,
  injectPreviewBridge,
  PREVIEW_BASE_PATH_HEADER,
  PREVIEW_BOOT_PARAM,
  PREVIEW_DESTINATION_HEADER,
  PREVIEW_MODE_PARAM,
  PREVIEW_SERVICE_WORKER_HEADER,
  PREVIEW_TARGET_HEADER,
} from '../../services/preview-bridge.js';
import { PREVIEW_CONTEXT_COOKIE_NAME } from '../../services/preview-cookies.js';
import {
  classifyPreviewRequest,
  PREVIEW_SANDBOX_CSP,
  proxyRequestHeaders,
  proxyResponseHeaders,
  rewriteLocationHeader,
  rewritePlainModeBody,
  shouldServeBootstrap,
  stripInternalQueryParams,
  type PreviewProxyScope,
} from '../../services/preview-proxy.js';
import { forceSameOriginPreview, sameOriginPreviewSession } from '../previews.js';
import { buildPreviewPathPrefix, parsePreviewPath } from '../../utils/preview-path.js';

const target: NormalizedPreviewTarget = {
  target: 'http://127.0.0.1:3000',
  origin: 'http://127.0.0.1:3000',
  basePath: '',
};
const scope: PreviewProxyScope = { workspaceId: 'workspace-1', target, previewToken: null };
const prefix = '/view/workspace-1';

describe('classifyPreviewRequest', () => {
  it('serves the bootstrap page to browser navigations that are not yet worker-controlled', () => {
    const context = classifyPreviewRequest('GET', { 'sec-fetch-dest': 'iframe', accept: 'text/html' }, '');
    expect(context).toMatchObject({ serviceWorker: false, document: true, embedded: true, plainMode: false, bootstrapped: false });
    expect(shouldServeBootstrap(context, 'GET')).toBe(true);
  });

  it('proxies the real document once the worker re-navigated or plain mode was chosen', () => {
    const booted = classifyPreviewRequest('GET', { accept: 'text/html,*/*' }, `?${PREVIEW_BOOT_PARAM}=1`);
    expect(booted.document).toBe(true);
    expect(shouldServeBootstrap(booted, 'GET')).toBe(false);

    const plain = classifyPreviewRequest('GET', { 'sec-fetch-dest': 'document' }, `?${PREVIEW_MODE_PARAM}=plain`);
    expect(plain).toMatchObject({ document: true, embedded: false, plainMode: true });
    expect(shouldServeBootstrap(plain, 'GET')).toBe(false);
  });

  it('trusts the service worker marker for navigation and destination', () => {
    const navigation = classifyPreviewRequest('GET', {
      [PREVIEW_SERVICE_WORKER_HEADER]: 'navigate',
      [PREVIEW_DESTINATION_HEADER]: 'iframe',
      'sec-fetch-dest': 'empty',
    }, '');
    expect(navigation).toMatchObject({ serviceWorker: true, document: true, embedded: true });
    expect(shouldServeBootstrap(navigation, 'GET')).toBe(false);

    const asset = classifyPreviewRequest('GET', {
      [PREVIEW_SERVICE_WORKER_HEADER]: 'subresource',
      [PREVIEW_DESTINATION_HEADER]: 'script',
      accept: 'text/html',
    }, '');
    expect(asset.document).toBe(false);
  });

  it('never treats fetch() calls or form posts as bootstrap candidates', () => {
    const json = classifyPreviewRequest('GET', { accept: '*/*' }, '');
    expect(json.document).toBe(false);
    const post = classifyPreviewRequest('POST', { 'sec-fetch-dest': 'document' }, '');
    expect(post.document).toBe(true);
    expect(shouldServeBootstrap(post, 'POST')).toBe(false);
  });
});

describe('proxyRequestHeaders', () => {
  it('maps browser origin and referer to the target without forwarding Agent Tower cookies', () => {
    const headers = proxyRequestHeaders({
      host: 'tower.example.com',
      origin: 'https://tower.example.com',
      referer: 'https://tower.example.com/view/workspace-1/settings?tab=team',
      cookie: [
        'agent-tower-access=legacy-secret',
        'agent-tower-access-0123456789abcdef=scoped-secret',
        '__Host-agent-tower-tunnel=tunnel',
        `${PREVIEW_CONTEXT_COOKIE_NAME}=workspace-1`,
        'preview-session=abc',
      ].join('; '),
      'cf-ray': 'ray',
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '203.0.113.10',
      'x-forwarded-proto': 'https',
      [PREVIEW_SERVICE_WORKER_HEADER]: 'navigate',
      [PREVIEW_DESTINATION_HEADER]: 'iframe',
      'sec-fetch-dest': 'iframe',
    }, { ...scope, target: { target: 'http://127.0.0.1:5173/app', origin: 'http://127.0.0.1:5173', basePath: '/app' } }, '/app/settings?tab=team');

    expect(headers.host).toBe('127.0.0.1:5173');
    expect(headers.origin).toBe('http://127.0.0.1:5173');
    expect(headers.referer).toBe('http://127.0.0.1:5173/app/settings?tab=team');
    expect(headers.cookie).toBe('preview-session=abc');
    expect(headers['x-forwarded-host']).toBe('tower.example.com');
    expect(headers['x-forwarded-proto']).toBe('https');
    expect(headers['cf-ray']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers[PREVIEW_SERVICE_WORKER_HEADER]).toBeUndefined();
    expect(headers[PREVIEW_DESTINATION_HEADER]).toBeUndefined();
    expect(headers['sec-fetch-dest']).toBeUndefined();
  });

  it('maps virtualized referers (service worker mode) back to the target root', () => {
    const headers = proxyRequestHeaders({
      host: 'tower.example.com',
      referer: 'https://tower.example.com/dashboard?x=1',
    }, scope, '/api/data');

    expect(headers.referer).toBe('http://127.0.0.1:3000/dashboard?x=1');
  });
});

describe('proxyResponseHeaders', () => {
  it('removes frame restrictions and tags embedded documents for the worker and the fallback hook', () => {
    const headers = proxyResponseHeaders({
      'content-type': 'text/html',
      'content-security-policy': "default-src 'self'",
      'x-frame-options': 'DENY',
      'content-length': '12',
      'cache-control': 'max-age=60',
    }, scope, { 'x-forwarded-proto': 'https' }, { document: true, embedded: true });

    expect(headers['x-frame-options']).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
    expect(headers['content-security-policy']).toBe(PREVIEW_SANDBOX_CSP);
    expect(headers[PREVIEW_TARGET_HEADER]).toBe('http://127.0.0.1:3000');
    expect(headers[PREVIEW_BASE_PATH_HEADER]).toBe('');
    expect(headers['cache-control']).toBe('no-store');
    const cookies = headers['set-cookie'] as string[];
    expect(cookies.some((cookie) => cookie.startsWith(`${PREVIEW_CONTEXT_COOKIE_NAME}=workspace-1`) && cookie.includes('Secure'))).toBe(true);
  });

  it('keeps top-level previews unsandboxed and passes other responses through', () => {
    const topLevel = proxyResponseHeaders({ 'content-type': 'text/html' }, scope, {}, { document: true, embedded: false });
    expect(topLevel['content-security-policy']).toBeUndefined();
    expect(topLevel[PREVIEW_TARGET_HEADER]).toBe('http://127.0.0.1:3000');

    const asset = proxyResponseHeaders({
      'content-type': 'application/javascript',
      'content-length': '42',
      'access-control-allow-origin': 'http://127.0.0.1:3000',
      etag: '"abc"',
    }, scope, {}, { document: false, embedded: false });
    expect(asset['content-length']).toBe('42');
    expect(asset['content-security-policy']).toBeUndefined();
    expect(asset[PREVIEW_TARGET_HEADER]).toBeUndefined();
    expect(asset['set-cookie']).toBeUndefined();
    expect(asset['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(asset.etag).toBe('"abc"');
  });

  it('rewrites redirects into the prefix and keeps target cookies usable across the whole proxy', () => {
    const headers = proxyResponseHeaders({
      location: 'http://127.0.0.1:3000/login?next=%2F',
      'set-cookie': [
        'session=abc; Domain=127.0.0.1; Path=/account; HttpOnly; SameSite=Lax',
        'agent-tower-access=target-session; Path=/; HttpOnly',
      ],
    }, scope, {}, { document: false, embedded: false });

    expect(headers.location).toBe('/view/workspace-1/login?next=%2F');
    const cookies = headers['set-cookie'] as string[];
    expect(cookies[0]).toBe('session=abc; Path=/; HttpOnly; SameSite=Lax');
    expect(cookies[1]).toMatch(/^agent-tower-preview-[0-9a-f]{16}-target-/);
    expect(cookies[1]).not.toMatch(/^agent-tower-access=/);
  });
});

describe('rewriteLocationHeader', () => {
  it('rewrites same-origin absolute paths into the preview prefix', () => {
    expect(rewriteLocationHeader('/foo?bar=1#section', scope)).toBe('/view/workspace-1/foo?bar=1#section');
  });

  it('does not add the preview prefix twice', () => {
    expect(rewriteLocationHeader('/view/workspace-1/foo?bar=1#section', scope))
      .toBe('/view/workspace-1/foo?bar=1#section');
  });

  it('does not rewrite external absolute locations even when their path starts with the preview prefix', () => {
    const external = 'https://example.com/view/workspace-1/foo?bar=1#section';
    expect(rewriteLocationHeader(external, scope)).toBe(external);
  });

  it('strips the target base path and keeps tokenized prefixes', () => {
    const token = 'pv1.d29ya3NwYWNlLTE.123.nonce.signature';
    const tokenScope: PreviewProxyScope = {
      workspaceId: 'workspace-1',
      previewToken: token,
      target: { target: 'http://127.0.0.1:3000/app', origin: 'http://127.0.0.1:3000', basePath: '/app' },
    };
    expect(rewriteLocationHeader('http://127.0.0.1:3000/app/login', tokenScope))
      .toBe(`/view/workspace-1/__agent_tower_preview/${token}/login`);
  });
});

describe('plain mode body rewriting', () => {
  it('rewrites static root-relative references in HTML and CSS', () => {
    const html = '<script src="/assets/app.js"></script><link href="/styles/app.css" rel="stylesheet"><img srcset="/a.png 1x, /b.png 2x"><a href="//cdn.example.com/x">cdn</a>';
    const rewritten = rewritePlainModeBody(html, prefix, 'html');
    expect(rewritten).toContain(`src="${prefix}/assets/app.js"`);
    expect(rewritten).toContain(`href="${prefix}/styles/app.css"`);
    expect(rewritten).toContain(`srcset="${prefix}/a.png 1x, ${prefix}/b.png 2x"`);
    expect(rewritten).toContain('href="//cdn.example.com/x"');

    expect(rewritePlainModeBody('body { background: url("/images/bg.png"); }', prefix, 'css'))
      .toContain(`url("${prefix}/images/bg.png")`);
  });
});

describe('bridge injection', () => {
  it('injects the bridge before any application script and preserves multi-byte content', () => {
    const html = Buffer.from('<html><head><meta charset="utf-8"><script id="app">1</script></head><body>你好 ☃</body></html>', 'utf8');
    const tag = buildPreviewBridgeScript({
      mode: 'prefix',
      prefix,
      workspaceId: 'workspace-1',
      targetOrigin: target.origin,
      targetBasePath: '',
      serviceWorker: true,
    });
    const output = injectPreviewBridge(html, tag).toString('utf8');

    expect(output.indexOf('data-agent-tower-preview-bridge')).toBeLessThan(output.indexOf('id="app"'));
    expect(output).toContain('你好 ☃');
    expect(output).toContain('"serviceWorker":true');
    expect(output).toContain('history.replaceState');
    expect(output).toContain('window.WebSocket = PreviewWebSocket');
    expect(injectPreviewBridge(Buffer.from(output, 'utf8'), tag).toString('utf8')).toBe(output);
  });

  it('generates a gateway bridge with heartbeat and a worker script bound to its scope', () => {
    const gatewayTag = buildPreviewBridgeScript({
      mode: 'gateway',
      prefix: '',
      workspaceId: 'workspace-1',
      targetOrigin: target.origin,
      targetBasePath: '',
      serviceWorker: false,
      heartbeatPath: '/__agent_tower_preview_heartbeat',
    });
    expect(gatewayTag).toContain('"heartbeatPath":"/__agent_tower_preview_heartbeat"');
    expect(gatewayTag).toContain('window.fetch =');

    const worker = buildPreviewServiceWorkerScript();
    expect(worker).toContain("self.addEventListener('fetch'");
    expect(worker).toContain('self.registration.scope');
    expect(worker).toContain(PREVIEW_SERVICE_WORKER_HEADER);

    const bootstrap = buildPreviewBootstrapPage({ scope: `${prefix}/` });
    expect(bootstrap).toContain('navigator.serviceWorker.register');
    expect(bootstrap).toContain(`${prefix}/__agent_tower_preview_sw.js`);
    expect(bootstrap).toContain(PREVIEW_MODE_PARAM);
  });
});

describe('same-origin sessions', () => {
  it('describes the same-origin proxy entry', () => {
    expect(sameOriginPreviewSession('workspace-1', target, 0)).toEqual({
      id: 'same-origin',
      target: 'http://127.0.0.1:3000',
      mode: 'remote',
      kind: 'same-origin',
      viewUrl: '/view/workspace-1/',
      expiresAt: new Date(24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it('honours the current and the legacy Docker environment switch', () => {
    expect(forceSameOriginPreview({})).toBe(false);
    expect(forceSameOriginPreview({ AGENT_TOWER_PREVIEW_FORCE_SAME_ORIGIN: 'true' })).toBe(true);
    expect(forceSameOriginPreview({ AGENT_TOWER_PREVIEW_FORCE_TUNNEL: 'true' })).toBe(true);
  });

  it('strips internal bootstrap parameters before reaching the target', () => {
    expect(stripInternalQueryParams(`?a=1&${PREVIEW_BOOT_PARAM}=1&${PREVIEW_MODE_PARAM}=plain`)).toBe('?a=1');
    expect(stripInternalQueryParams(`?${PREVIEW_BOOT_PARAM}=1`)).toBe('');
  });
});

describe('parsePreviewPath', () => {
  it('parses preview paths', () => {
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
    expect(buildPreviewPathPrefix('workspace-1', token))
      .toBe(`/view/workspace-1/__agent_tower_preview/${token}`);
  });
});
