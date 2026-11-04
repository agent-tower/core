/**
 * Browser-side runtime for workspace previews.
 *
 * Three pieces are generated here:
 *
 * 1. The bridge script injected into every proxied HTML document. It keeps the
 *    page inside its preview entry (prefix-aware URL rewriting, toolbar sync,
 *    optional address virtualization) and isolates browser storage.
 * 2. The service worker used by the same-origin `/view/:workspaceId/` proxy.
 *    It transparently rewrites every request a controlled document makes so
 *    root-relative paths (`/assets/app.js`, `/api/...`, `import "/src/x.ts"`)
 *    reach the workspace target without any body rewriting.
 * 3. The bootstrap page that registers the service worker before the real
 *    document is loaded, with a plain-mode fallback when workers are
 *    unavailable (insecure LAN origins, old browsers).
 */

export const PREVIEW_BRIDGE_SOURCE = 'agent-tower-preview';
export const PREVIEW_HOST_SOURCE = 'agent-tower-preview-host';
export const PREVIEW_SERVICE_WORKER_SEGMENT = '__agent_tower_preview_sw.js';
export const PREVIEW_SERVICE_WORKER_HEADER = 'x-agent-tower-preview-sw';
export const PREVIEW_DESTINATION_HEADER = 'x-agent-tower-preview-dest';
export const PREVIEW_TARGET_HEADER = 'x-agent-tower-preview-target';
export const PREVIEW_BASE_PATH_HEADER = 'x-agent-tower-preview-base-path';
export const PREVIEW_BOOT_PARAM = '__agent_tower_preview_boot';
export const PREVIEW_MODE_PARAM = '__agent_tower_preview_mode';
export const PREVIEW_TARGET_MESSAGE = 'agent-tower-preview-target';
export const PREVIEW_INTERNAL_QUERY_PARAMS = [PREVIEW_BOOT_PARAM, PREVIEW_MODE_PARAM] as const;

export interface PreviewBridgeOptions {
  /** `gateway`: dedicated origin per workspace. `prefix`: same-origin `/view/:id` proxy. */
  mode: 'gateway' | 'prefix';
  /** Proxy prefix without trailing slash (`/view/workspace-1`). Empty for gateways. */
  prefix: string;
  workspaceId: string;
  targetOrigin: string;
  targetBasePath: string;
  /** Prefix mode only: the document is controlled by the preview service worker. */
  serviceWorker: boolean;
  /** Gateway mode only: path polled to keep the gateway lease alive. */
  heartbeatPath?: string | null;
}

export function buildPreviewBridgeScript(options: PreviewBridgeOptions): string {
  const config = {
    mode: options.mode,
    prefix: options.prefix,
    workspaceId: options.workspaceId,
    targetOrigin: options.targetOrigin,
    targetBasePath: options.targetBasePath,
    serviceWorker: options.serviceWorker,
    heartbeatPath: options.heartbeatPath ?? null,
    previewSource: PREVIEW_BRIDGE_SOURCE,
    hostSource: PREVIEW_HOST_SOURCE,
    targetMessage: PREVIEW_TARGET_MESSAGE,
    internalParams: PREVIEW_INTERNAL_QUERY_PARAMS,
  };

  return `<script data-agent-tower-preview-bridge>(() => {
  const config = ${JSON.stringify(config)};
  const prefix = config.prefix;
  const prefixDir = prefix + '/';
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
  const privateHostPattern = /^(10\\.|172\\.(1[6-9]|2\\d|3[01])\\.|192\\.168\\.|169\\.254\\.|100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.)/;
  let target;
  try { target = new URL(config.targetOrigin); } catch { target = null; }
  const basePath = config.targetBasePath || '';
  const embedded = window.self !== window.top;
  const virtual = config.mode === 'prefix' && config.serviceWorker && embedded;
  const post = (message) => {
    if (!embedded) return;
    try { window.parent.postMessage({ source: config.previewSource, ...message }, '*'); } catch {}
  };

  const normalizeProtocol = (protocol) => protocol === 'ws:' ? 'http:' : protocol === 'wss:' ? 'https:' : protocol;
  const normalizeHost = (hostname) => {
    const lower = hostname.toLowerCase();
    return loopbackHosts.has(lower) ? 'loopback' : lower;
  };
  const effectivePort = (url) => url.port || (normalizeProtocol(url.protocol) === 'https:' ? '443' : '80');
  const sameEndpoint = (left, right) => normalizeProtocol(left.protocol) === normalizeProtocol(right.protocol)
    && normalizeHost(left.hostname) === normalizeHost(right.hostname)
    && effectivePort(left) === effectivePort(right);
  const isPrefixed = (pathname) => prefix !== '' && (pathname === prefix || pathname.startsWith(prefixDir));
  const stripBasePath = (pathname) => basePath && (pathname === basePath || pathname.startsWith(basePath + '/'))
    ? (pathname.slice(basePath.length) || '/')
    : pathname;
  const stripInternalParams = (search) => {
    const params = new URLSearchParams(search);
    for (const name of config.internalParams) params.delete(name);
    const next = params.toString();
    return next ? '?' + next : '';
  };
  const isServerReachableHost = (hostname) => {
    const lower = hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
    return loopbackHosts.has(lower)
      || privateHostPattern.test(lower)
      || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
      || !lower.includes('.')
      || /\\.(local|internal|lan|home|home\\.arpa|localhost)$/.test(lower);
  };

  // Classify a URL used by the page. Returns null when the proxy should not touch it.
  const classify = (raw, base) => {
    let url;
    try { url = new URL(raw, base || window.location.href); } catch { return null; }
    const isWs = url.protocol === 'ws:' || url.protocol === 'wss:';
    if (!isWs && url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const page = window.location;
    const isPage = normalizeProtocol(url.protocol) === page.protocol && url.host.toLowerCase() === page.host.toLowerCase();
    const isTarget = Boolean(target) && sameEndpoint(url, target);
    if (isPage) {
      if (config.mode === 'gateway' || isPrefixed(url.pathname)) return null;
      return { url, pathname: url.pathname, isWs };
    }
    if (isTarget) return { url, pathname: stripBasePath(url.pathname), isWs };
    return null;
  };
  const proxyUrl = (raw, base) => {
    const info = classify(raw, base);
    if (!info) return null;
    const protocol = info.isWs
      ? (window.location.protocol === 'https:' ? 'wss:' : 'ws:')
      : window.location.protocol;
    return protocol + '//' + window.location.host + prefix + info.pathname + info.url.search + info.url.hash;
  };
  const currentTargetPath = () => {
    const location = window.location;
    let pathname = location.pathname;
    if (config.mode === 'prefix' && !virtual && isPrefixed(pathname)) pathname = pathname.slice(prefix.length) || '/';
    return pathname + stripInternalParams(location.search) + location.hash;
  };

  // Virtualize the address bar for SPA routers (service worker mode) or just
  // drop the internal bootstrap parameters from the visible URL.
  try {
    if (config.mode === 'prefix') {
      const location = window.location;
      const search = stripInternalParams(location.search);
      if (virtual) {
        const pathname = isPrefixed(location.pathname) ? (location.pathname.slice(prefix.length) || '/') : location.pathname;
        history.replaceState(history.state, '', pathname + search + location.hash);
      } else if (search !== location.search) {
        history.replaceState(history.state, '', location.pathname + search + location.hash);
      }
    }
  } catch {}

  const sendLocation = () => post({ type: 'location', path: currentTargetPath(), href: window.location.href, title: document.title });
  const scheduleLocation = () => window.setTimeout(sendLocation, 0);

  const nativePushState = History.prototype.pushState;
  const nativeReplaceState = History.prototype.replaceState;
  const rewriteHistoryUrl = (url) => {
    if (url === undefined || url === null || virtual) return url;
    try {
      const next = proxyUrl(url instanceof URL ? url.toString() : String(url));
      return next === null ? url : next;
    } catch {
      return url;
    }
  };
  History.prototype.pushState = function (state, unused, url) {
    const result = nativePushState.call(this, state, unused, rewriteHistoryUrl(url));
    scheduleLocation();
    return result;
  };
  History.prototype.replaceState = function (state, unused, url) {
    const result = nativeReplaceState.call(this, state, unused, rewriteHistoryUrl(url));
    scheduleLocation();
    return result;
  };

  // Without a service worker the page's own network calls have to be rewritten here.
  if (!config.serviceWorker) {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          const next = proxyUrl(String(input));
          return nativeFetch(next === null ? input : next, init);
        }
        if (input instanceof Request) {
          const next = proxyUrl(input.url);
          return nativeFetch(next === null ? input : new Request(next, input), init);
        }
      } catch {}
      return nativeFetch(input, init);
    };
    const nativeXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      let next = url;
      try { next = proxyUrl(String(url)) ?? url; } catch {}
      return nativeXhrOpen.call(this, method, next, ...rest);
    };
    const NativeEventSource = window.EventSource;
    if (NativeEventSource) {
      function PreviewEventSource(url, options) {
        let next = url;
        try { next = proxyUrl(String(url)) ?? url; } catch {}
        return new NativeEventSource(next, options);
      }
      PreviewEventSource.prototype = NativeEventSource.prototype;
      Object.setPrototypeOf(PreviewEventSource, NativeEventSource);
      window.EventSource = PreviewEventSource;
    }
  }

  // Service workers never see WebSocket handshakes, so always route them here.
  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    function PreviewWebSocket(url, protocols) {
      let next = url;
      try { next = proxyUrl(String(url)) ?? url; } catch {}
      return protocols === undefined ? new NativeWebSocket(next) : new NativeWebSocket(next, protocols);
    }
    PreviewWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(PreviewWebSocket, NativeWebSocket);
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      try { Object.defineProperty(PreviewWebSocket, key, { value: NativeWebSocket[key] }); } catch {}
    }
    window.WebSocket = PreviewWebSocket;
  }

  const nativeOpen = window.open;
  window.open = function (url, ...rest) {
    let next = url;
    try { if (url !== undefined && url !== null) next = proxyUrl(String(url)) ?? url; } catch {}
    return nativeOpen.call(this, next, ...rest);
  };

  // Real navigations (links the app did not handle itself, plain forms).
  window.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    let url;
    try { url = new URL(anchor.href, window.location.href); } catch { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const newTab = anchor.target === '_blank';
    const next = proxyUrl(url.toString());
    if (next !== null) {
      if (anchor.hasAttribute('download')) {
        const original = anchor.getAttribute('href');
        anchor.setAttribute('href', next);
        window.setTimeout(() => { if (original !== null) anchor.setAttribute('href', original); }, 0);
        return;
      }
      event.preventDefault();
      if (newTab) window.open(next, '_blank');
      else window.location.assign(next);
      return;
    }
    const page = window.location;
    const samePage = url.protocol === page.protocol && url.host.toLowerCase() === page.host.toLowerCase();
    if (samePage || !isServerReachableHost(url.hostname)) return;
    event.preventDefault();
    post({ type: 'navigate-target', href: url.toString(), newTab });
  });
  window.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter;
    const action = submitter && submitter.hasAttribute('formaction') ? submitter.formAction : form.action;
    let next = null;
    try { next = proxyUrl(action); } catch {}
    if (next === null) return;
    if (submitter && submitter.hasAttribute('formaction')) submitter.formAction = next;
    else form.action = next;
  });

  window.addEventListener('popstate', scheduleLocation);
  window.addEventListener('hashchange', scheduleLocation);
  window.addEventListener('pageshow', scheduleLocation);
  window.addEventListener('message', (event) => {
    if (!embedded || event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.source !== config.hostSource) return;
    if (message.action === 'back') window.history.back();
    else if (message.action === 'forward') window.history.forward();
    else if (message.action === 'stop') window.stop();
    else if (message.action === 'reload') {
      if (virtual) {
        const location = window.location;
        window.location.replace(prefix + location.pathname + location.search + location.hash);
      } else {
        window.location.reload();
      }
    }
  });

  if (config.serviceWorker && navigator.serviceWorker && navigator.serviceWorker.controller) {
    try {
      navigator.serviceWorker.controller.postMessage({
        type: config.targetMessage,
        target: { origin: config.targetOrigin, basePath: basePath },
      });
    } catch {}
  }

  // Same-origin previews share Agent Tower's storage; keep each workspace in
  // its own namespace so a preview cannot clobber the host application.
  if (config.mode === 'prefix') {
    const namespace = '__agent_tower_preview:' + config.workspaceId + ':';
    const wrapStorage = (storage) => {
      const keys = () => {
        const out = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key !== null && key.startsWith(namespace)) out.push(key.slice(namespace.length));
        }
        return out;
      };
      const api = {
        getItem: (key) => storage.getItem(namespace + String(key)),
        setItem: (key, value) => storage.setItem(namespace + String(key), String(value)),
        removeItem: (key) => storage.removeItem(namespace + String(key)),
        clear: () => { for (const key of keys()) storage.removeItem(namespace + key); },
        key: (index) => keys()[index] ?? null,
        get length() { return keys().length; },
      };
      return new Proxy(api, {
        get(base, property) {
          if (property in base) {
            const value = base[property];
            return typeof value === 'function' ? value.bind(base) : value;
          }
          if (typeof property !== 'string') return undefined;
          const stored = storage.getItem(namespace + property);
          return stored === null ? undefined : stored;
        },
        set(base, property, value) {
          storage.setItem(namespace + String(property), String(value));
          return true;
        },
        deleteProperty(base, property) {
          storage.removeItem(namespace + String(property));
          return true;
        },
        has(base, property) {
          return property in base || storage.getItem(namespace + String(property)) !== null;
        },
        ownKeys() { return keys(); },
        getOwnPropertyDescriptor(base, property) {
          const stored = storage.getItem(namespace + String(property));
          if (stored === null) return undefined;
          return { value: stored, enumerable: true, configurable: true, writable: true };
        },
      });
    };
    for (const name of ['localStorage', 'sessionStorage']) {
      try {
        const storage = window[name];
        if (!storage) continue;
        const wrapped = wrapStorage(storage);
        Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => wrapped });
      } catch {}
    }
  }

  if (config.heartbeatPath) {
    const heartbeat = () => fetch(config.heartbeatPath, { credentials: 'include', cache: 'no-store' }).catch(() => {});
    window.setInterval(heartbeat, 30000);
    heartbeat();
  }

  sendLocation();
})();</script>`;
}

const HEAD_PATTERN = /<head(?:\s[^>]*)?>/i;
const BRIDGE_MARKER = 'data-agent-tower-preview-bridge';

/** Insert the bridge as the very first thing inside `<head>` so it runs before any app script. */
export function injectPreviewBridge(html: Buffer, scriptTag: string): Buffer {
  const text = html.toString('latin1');
  if (text.includes(BRIDGE_MARKER)) return html;
  const match = HEAD_PATTERN.exec(text);
  const script = Buffer.from(scriptTag, 'utf8');
  if (!match) return Buffer.concat([script, html]);
  const offset = Buffer.byteLength(text.slice(0, match.index + match[0].length), 'latin1');
  return Buffer.concat([html.subarray(0, offset), script, html.subarray(offset)]);
}

export function buildPreviewServiceWorkerScript(): string {
  const config = {
    swHeader: PREVIEW_SERVICE_WORKER_HEADER,
    destinationHeader: PREVIEW_DESTINATION_HEADER,
    targetHeader: PREVIEW_TARGET_HEADER,
    basePathHeader: PREVIEW_BASE_PATH_HEADER,
    targetMessage: PREVIEW_TARGET_MESSAGE,
  };

  return `(() => {
  const config = ${JSON.stringify(config)};
  const scope = new URL(self.registration.scope);
  const prefixDir = scope.pathname.endsWith('/') ? scope.pathname : scope.pathname + '/';
  const prefix = prefixDir.slice(0, -1);
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
  const targets = new Map();
  let lastTarget = null;

  const parseTarget = (origin, basePath) => {
    try {
      const url = new URL(origin);
      return {
        protocol: url.protocol,
        hostname: url.hostname.toLowerCase(),
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        basePath: basePath || '',
      };
    } catch {
      return null;
    }
  };
  const rememberTarget = (clientId, target) => {
    if (!target) return;
    lastTarget = target;
    if (clientId) targets.set(clientId, target);
  };
  const normalizeHost = (hostname) => loopbackHosts.has(hostname) ? 'loopback' : hostname;
  const matchesTarget = (url, target) => Boolean(target)
    && url.protocol === target.protocol
    && normalizeHost(url.hostname.toLowerCase()) === normalizeHost(target.hostname)
    && (url.port || (url.protocol === 'https:' ? '443' : '80')) === target.port;
  const stripBasePath = (pathname, basePath) => basePath && (pathname === basePath || pathname.startsWith(basePath + '/'))
    ? (pathname.slice(basePath.length) || '/')
    : pathname;
  const isPrefixed = (pathname) => pathname === prefix || pathname.startsWith(prefixDir);

  const resolve = (url, clientId) => {
    if (url.origin === scope.origin) {
      if (isPrefixed(url.pathname)) return url.href;
      return scope.origin + prefix + url.pathname + url.search;
    }
    const target = targets.get(clientId) || lastTarget;
    if (matchesTarget(url, target)) {
      return scope.origin + prefix + stripBasePath(url.pathname, target.basePath) + url.search;
    }
    return null;
  };

  const forward = async (request, nextUrl, navigate, clientId) => {
    const headers = new Headers(request.headers);
    headers.set(config.swHeader, navigate ? 'navigate' : 'subresource');
    headers.set(config.destinationHeader, request.destination || (navigate ? 'document' : 'empty'));
    const init = {
      method: request.method,
      headers,
      mode: 'same-origin',
      credentials: 'include',
      cache: request.cache === 'only-if-cached' ? 'default' : request.cache,
      redirect: navigate ? 'manual' : request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      signal: request.signal,
    };
    // Browsers only stream upload bodies over HTTP/2+, so buffer them: Agent
    // Tower itself is reached over HTTP/1.1 (local port, tunnel, reverse proxy).
    const outgoing = request.method === 'GET' || request.method === 'HEAD' || request.body === null
      ? new Request(nextUrl, init)
      : new Request(nextUrl, { ...init, body: await request.arrayBuffer() });
    const response = await fetch(outgoing);
    if (navigate) {
      const origin = response.headers.get(config.targetHeader);
      if (origin) rememberTarget(clientId, parseTarget(origin, response.headers.get(config.basePathHeader) || ''));
      return response;
    }
    // Hand back a synthetic response so the browser attributes it to the URL the
    // page asked for: module scripts then see a virtual import.meta.url instead
    // of the proxy prefix, matching the virtualized document address.
    if (response.type !== 'basic' && response.type !== 'default' && response.type !== 'cors') return response;
    if (response.status === 0) return response;
    const nullBody = response.status === 204 || response.status === 205 || response.status === 304 || request.method === 'HEAD';
    try {
      return new Response(nullBody ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };

  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== config.targetMessage || !data.target) return;
    rememberTarget(event.source && event.source.id, parseTarget(data.target.origin, data.target.basePath));
  });
  self.addEventListener('fetch', (event) => {
    const request = event.request;
    let url;
    try { url = new URL(request.url); } catch { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const navigate = request.mode === 'navigate';
    const clientId = (navigate ? event.resultingClientId : event.clientId) || '';
    const nextUrl = resolve(url, clientId);
    if (nextUrl === null) return;
    event.respondWith(forward(request, nextUrl, navigate, clientId));
  });
})();`;
}

export interface PreviewBootstrapOptions {
  /** Prefix with trailing slash (`/view/workspace-1/`). */
  scope: string;
}

export function buildPreviewBootstrapPage(options: PreviewBootstrapOptions): string {
  const config = {
    scope: options.scope,
    workerUrl: `${options.scope}${PREVIEW_SERVICE_WORKER_SEGMENT}`,
    bootParam: PREVIEW_BOOT_PARAM,
    modeParam: PREVIEW_MODE_PARAM,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Tower Preview</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; color: #6b7280; background: #fff; }
</style>
</head>
<body>
<div>Loading preview…</div>
<script>(async () => {
  const config = ${JSON.stringify(config)};
  const url = new URL(window.location.href);
  const plain = () => {
    url.searchParams.set(config.modeParam, 'plain');
    window.location.replace(url.toString());
  };
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return plain();
  try {
    const timeout = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 8000));
    await Promise.race([
      (async () => {
        await navigator.serviceWorker.register(config.workerUrl, { scope: config.scope });
        await navigator.serviceWorker.ready;
      })(),
      timeout,
    ]);
    url.searchParams.set(config.bootParam, '1');
    window.location.replace(url.toString());
  } catch (error) {
    console.warn('[agent-tower preview] service worker unavailable, using plain proxy mode', error);
    plain();
  }
})();</script>
</body>
</html>`;
}
