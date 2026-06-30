import net from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isTunnelRequest } from './tunnel-auth.js';

const LOCAL_ONLY_MESSAGE = '请在本机 Agent Tower 打开执行。';

function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    return closing >= 0 ? trimmed.slice(1, closing) : trimmed;
  }
  const withoutPort = trimmed.split(':')[0] ?? trimmed;
  return withoutPort;
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = normalizeHost(host);
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1';
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address
    .replace(/^::ffff:/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();

  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  if (net.isIP(normalized) === 4) {
    return normalized.startsWith('127.');
  }

  return false;
}

function getRequestHost(request: FastifyRequest): string | undefined {
  return request.headers.host;
}

function getRemoteAddress(request: FastifyRequest): string | undefined {
  return request.ip || request.socket.remoteAddress;
}

function sameOrigin(origin: URL, hostHeader: string): boolean {
  return origin.host.toLowerCase() === hostHeader.toLowerCase();
}

function reject(reply: FastifyReply): void {
  reply.code(403).send({
    error: 'Agent CLI install is local-only',
    code: 'AGENT_CLI_INSTALL_LOCAL_ONLY',
    message: LOCAL_ONLY_MESSAGE,
  });
}

export async function agentCliLocalOnlyHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (isTunnelRequest(request)) {
    reject(reply);
    return;
  }

  const host = getRequestHost(request);
  const remoteAddress = getRemoteAddress(request);

  if (!isLoopbackHost(host) || !isLoopbackAddress(remoteAddress)) {
    reject(reply);
    return;
  }

  const originHeader = request.headers.origin;
  if (typeof originHeader === 'string' && originHeader.length > 0) {
    let origin: URL;
    try {
      origin = new URL(originHeader);
    } catch {
      reject(reply);
      return;
    }

    if (!isLoopbackHost(origin.host) || !host || !sameOrigin(origin, host)) {
      reject(reply);
    }
  }
}
