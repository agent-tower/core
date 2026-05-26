import net from 'node:net';
import { prisma } from '../utils/index.js';
import { NotFoundError, ServiceError } from '../errors.js';

const DEFAULT_SCHEME = 'http';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const CONNECTION_TIMEOUT_MS = 1500;

export interface NormalizedPreviewTarget {
  target: string;
  origin: string;
  basePath: string;
}

export interface PreviewStatus {
  configured: boolean;
  ready: boolean;
  target: string | null;
  viewUrl: string | null;
  error: string | null;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') && value.length > 1 ? value.slice(0, -1) : value;
}

function withDefaultScheme(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return `${DEFAULT_SCHEME}://127.0.0.1:${trimmed}`;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return trimmed;
  return `${DEFAULT_SCHEME}://${trimmed}`;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower === '::1' || lower === '[::1]') return '[::1]';
  if (lower === 'localhost') return '127.0.0.1';
  return lower;
}

function parsePort(url: URL): number {
  if (!url.port) {
    return url.protocol === 'https:' ? 443 : 80;
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceError('Preview target port must be between 1 and 65535', 'INVALID_PREVIEW_TARGET', 400);
  }
  return port;
}

function ensureLoopbackTarget(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServiceError('Preview target must use http or https', 'INVALID_PREVIEW_TARGET', 400);
  }

  if (url.username || url.password) {
    throw new ServiceError('Preview target must not include credentials', 'INVALID_PREVIEW_TARGET', 400);
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === '0.0.0.0') {
    url.hostname = '127.0.0.1';
    return;
  }

  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new ServiceError('Preview target host must be localhost, 127.0.0.1, or ::1', 'INVALID_PREVIEW_TARGET', 400);
  }
}

export function normalizePreviewTarget(input: string): NormalizedPreviewTarget {
  const value = input.trim();
  if (!value) {
    throw new ServiceError('Preview target is required', 'INVALID_PREVIEW_TARGET', 400);
  }

  let url: URL;
  try {
    url = new URL(withDefaultScheme(value));
  } catch {
    throw new ServiceError('Preview target is not a valid URL', 'INVALID_PREVIEW_TARGET', 400);
  }

  ensureLoopbackTarget(url);
  parsePort(url);

  url.hash = '';
  url.search = '';
  const hostname = normalizeHostname(url.hostname);
  url.hostname = hostname;

  const target = stripTrailingSlash(url.toString());
  const origin = url.origin;
  const basePath = url.pathname === '/' ? '' : stripTrailingSlash(url.pathname);

  return { target, origin, basePath };
}

async function canConnect(url: URL): Promise<{ ready: boolean; error: string | null }> {
  const port = parsePort(url);
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ready: boolean, error: string | null) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ready, error });
    };

    socket.setTimeout(CONNECTION_TIMEOUT_MS);
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, `Connection timed out after ${CONNECTION_TIMEOUT_MS}ms`));
    socket.once('error', (err) => done(false, err.message));
  });
}

export class PreviewService {
  async getTarget(workspaceId: string): Promise<NormalizedPreviewTarget | null> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, previewTarget: true },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }

    if (!workspace.previewTarget) return null;
    return normalizePreviewTarget(workspace.previewTarget);
  }

  async setTarget(workspaceId: string, targetInput: string | null): Promise<NormalizedPreviewTarget | null> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }

    if (targetInput === null || targetInput.trim() === '') {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { previewTarget: null },
      });
      return null;
    }

    const normalized = normalizePreviewTarget(targetInput);
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { previewTarget: normalized.target },
    });
    return normalized;
  }

  async getStatus(workspaceId: string): Promise<PreviewStatus> {
    const target = await this.getTarget(workspaceId);
    if (!target) {
      return {
        configured: false,
        ready: false,
        target: null,
        viewUrl: null,
        error: null,
      };
    }

    const result = await canConnect(new URL(target.origin));

    return {
      configured: true,
      ready: result.ready,
      target: target.target,
      viewUrl: `/view/${workspaceId}/`,
      error: result.error,
    };
  }
}
