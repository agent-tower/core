import { Tunnel } from 'cloudflared';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export type TunnelHealthStatus =
  | 'stopped'
  | 'starting'
  | 'checking'
  | 'healthy'
  | 'degraded'
  | 'localUnhealthy'
  | 'exited'
  | 'error'
  | 'linkReplaced';

export interface TunnelStatus {
  running: boolean;
  status: TunnelHealthStatus;
  url: string | null;
  startedAt: string | null;
  targetPort: number | null;
  generation: number;
  lastCheckedAt: string | null;
  lastHealthyAt: string | null;
  lastRemoteError: string | null;
  lastLocalError: string | null;
  lastExitAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  lastProcessOutput: string | null;
  consecutiveRemoteFailures: number;
  consecutiveLocalFailures: number;
  canRegenerate: boolean;
}

interface TunnelState {
  url: string | null;
  status: TunnelHealthStatus;
  tunnel: Tunnel | null;
  startedAt: string | null;
  targetPort: number | null;
  targetOrigin: string | null;
  token: string | null;
  generation: number;
  healthSecret: string | null;
  healthTimer: NodeJS.Timeout | null;
  healthCheckInFlight: boolean;
  healthCheckPromise: Promise<void> | null;
  lastCheckedAt: string | null;
  lastHealthyAt: string | null;
  lastRemoteError: string | null;
  lastLocalError: string | null;
  lastExitAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  consecutiveRemoteFailures: number;
  consecutiveLocalFailures: number;
  lastError: string | null;
  lastProcessOutput: string | null;
}

type HealthCheckResult = {
  ok: boolean;
  error: string | null;
};

const HEALTH_CHECK_INTERVAL_MS = 10000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const LOCAL_HEALTH_PATH = '/api/tunnel/health';
const LINK_REPLACED_STATUS_TTL_MS = 4000;
const TUNNEL_STARTUP_TIMEOUT_MS = 30000;
const TUNNEL_OUTPUT_MAX_CHARS = 4000;
const TUNNEL_QUICK_OPTIONS = {
  '--no-autoupdate': true,
} as const;

const state: TunnelState = {
  url: null,
  status: 'stopped',
  tunnel: null,
  startedAt: null,
  targetPort: null,
  targetOrigin: null,
  token: null,
  generation: 0,
  healthSecret: null,
  healthTimer: null,
  healthCheckInFlight: false,
  healthCheckPromise: null,
  lastCheckedAt: null,
  lastHealthyAt: null,
  lastRemoteError: null,
  lastLocalError: null,
  lastExitAt: null,
  lastExitCode: null,
  lastExitSignal: null,
  consecutiveRemoteFailures: 0,
  consecutiveLocalFailures: 0,
  lastError: null,
  lastProcessOutput: null,
};

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function sanitizeProcessOutput(output: string): string {
  return output
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

function appendProcessOutput(source: 'stdout' | 'stderr', output: string): void {
  const sanitized = sanitizeProcessOutput(output);
  if (!sanitized) return;

  const nextOutput = `${state.lastProcessOutput ? `${state.lastProcessOutput}\n` : ''}[${source}] ${sanitized}`;
  state.lastProcessOutput = nextOutput.length > TUNNEL_OUTPUT_MAX_CHARS
    ? nextOutput.slice(nextOutput.length - TUNNEL_OUTPUT_MAX_CHARS)
    : nextOutput;
}

function formatExitDetails(code: number | null | undefined, signal: NodeJS.Signals | null | undefined): string {
  if (typeof code === 'number') return `code ${code}`;
  if (signal) return `signal ${signal}`;
  return 'unknown exit status';
}

function buildExitErrorMessage(code: number | null | undefined, signal: NodeJS.Signals | null | undefined): string {
  return `cloudflared exited with ${formatExitDetails(code, signal)}`;
}

function clearHealthTimer(): void {
  if (!state.healthTimer) return;
  clearInterval(state.healthTimer);
  state.healthTimer = null;
}

function resetRuntimeState(nextStatus: TunnelHealthStatus): void {
  clearHealthTimer();
  state.url = null;
  state.status = nextStatus;
  state.tunnel = null;
  state.startedAt = null;
  state.targetPort = null;
  state.targetOrigin = null;
  state.token = null;
  state.healthSecret = null;
  state.healthCheckInFlight = false;
  state.healthCheckPromise = null;
  state.lastCheckedAt = null;
  state.lastHealthyAt = null;
  state.lastRemoteError = null;
  state.lastLocalError = null;
  state.lastExitAt = null;
  state.lastExitCode = null;
  state.lastExitSignal = null;
  state.lastError = null;
  state.lastProcessOutput = null;
  state.consecutiveRemoteFailures = 0;
  state.consecutiveLocalFailures = 0;
}

function buildHealthUrl(baseUrl: string, secret: string, generation: number): string {
  const healthUrl = new URL(LOCAL_HEALTH_PATH, baseUrl);
  healthUrl.searchParams.set('check', secret);
  healthUrl.searchParams.set('generation', String(generation));
  return healthUrl.toString();
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildTargetOrigin(port: number): string {
  return `http://localhost:${port}`;
}

async function checkLocalTarget(targetOrigin: string, secret: string, generation: number): Promise<HealthCheckResult> {
  try {
    const response = await fetchWithTimeout(
      buildHealthUrl(targetOrigin, secret, generation),
      { method: 'GET' },
    );
    if (!response.ok) {
      return { ok: false, error: `local health returned ${response.status}` };
    }

    const body = await response.json().catch(() => null) as { ok?: unknown; generation?: unknown } | null;
    if (!body?.ok || body.generation !== generation) {
      return { ok: false, error: 'local health response did not match current tunnel' };
    }

    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: sanitizeError(err) };
  }
}

function setHealthStatus(local: HealthCheckResult, checkedAt: string): void {
  if (!state.tunnel) return;

  if (!local.ok) {
    state.status = 'localUnhealthy';
    return;
  }

  state.status = 'healthy';
  state.lastHealthyAt = checkedAt;
}

async function runHealthCheck(): Promise<void> {
  if (state.healthCheckInFlight) {
    await state.healthCheckPromise;
    return;
  }
  if (!state.tunnel || !state.url || !state.healthSecret || !state.targetPort) return;

  state.healthCheckInFlight = true;
  state.healthCheckPromise = (async () => {
    try {
      const generation = state.generation;
      const targetOrigin = state.targetOrigin;
      const secret = state.healthSecret;
      if (!targetOrigin || !secret) return;

      const local = await checkLocalTarget(targetOrigin, secret, generation);
      const checkedAt = nowIso();
      state.lastCheckedAt = checkedAt;
      state.lastLocalError = local.error;
      state.consecutiveLocalFailures = local.ok ? 0 : state.consecutiveLocalFailures + 1;
      state.lastRemoteError = null;
      state.consecutiveRemoteFailures = 0;
      setHealthStatus(local, checkedAt);
    } finally {
      state.healthCheckInFlight = false;
      state.healthCheckPromise = null;
    }
  })();

  await state.healthCheckPromise;
}

function startHealthChecks(): void {
  clearHealthTimer();
  void runHealthCheck();
  state.healthTimer = setInterval(() => {
    void runHealthCheck();
  }, HEALTH_CHECK_INTERVAL_MS);
  state.healthTimer.unref?.();
}

function attachTunnelDiagnostics(tunnel: Tunnel): void {
  tunnel.on('stdout', (output) => appendProcessOutput('stdout', output));
  tunnel.on('stderr', (output) => appendProcessOutput('stderr', output));

  tunnel.on('exit', (code, signal) => {
    if (state.tunnel !== tunnel) return;
    clearHealthTimer();
    state.status = 'exited';
    state.url = null;
    state.tunnel = null;
    state.startedAt = null;
    state.token = null;
    state.healthSecret = null;
    state.targetPort = null;
    state.targetOrigin = null;
    state.lastExitAt = nowIso();
    state.lastExitCode = code ?? null;
    state.lastExitSignal = signal ?? null;
    state.lastError = buildExitErrorMessage(code, signal);
  });

  tunnel.on('error', (err) => {
    if (state.tunnel !== tunnel) return;
    state.lastError = sanitizeError(err);
  });
}

async function startTunnel(port: number, nextStatus: TunnelHealthStatus): Promise<{ url: string; token: string }> {
  if (state.tunnel && state.url && state.token) {
    return { url: state.url, token: state.token };
  }

  const targetOrigin = buildTargetOrigin(port);
  state.status = 'starting';
  state.lastError = null;
  state.lastExitAt = null;
  state.lastExitCode = null;
  state.lastExitSignal = null;
  state.lastProcessOutput = null;
  state.targetPort = port;
  state.targetOrigin = targetOrigin;

  const tunnel = Tunnel.quick(targetOrigin, TUNNEL_QUICK_OPTIONS);
  state.tunnel = tunnel;
  attachTunnelDiagnostics(tunnel);

  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settle(reject, new Error('Tunnel startup timed out (30s)'));
        state.tunnel = null;
        tunnel.stop();
      }, TUNNEL_STARTUP_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        tunnel.off('url', onUrl);
        tunnel.off('error', onError);
        tunnel.off('exit', onExit);
      };

      const settle = <T>(done: (value: T) => void, value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        done(value);
      };

      const onUrl = (nextUrl: string) => settle(resolve, nextUrl);
      const onError = (err: Error) => settle(reject, err);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(reject, new Error(buildExitErrorMessage(code, signal)));
      };

      tunnel.once('url', onUrl);
      tunnel.once('error', onError);
      tunnel.once('exit', onExit);
    });
  } catch (err) {
    state.tunnel = null;
    tunnel.stop();
    clearHealthTimer();
    state.status = 'error';
    state.url = null;
    state.startedAt = null;
    state.token = null;
    state.healthSecret = null;
    state.targetPort = null;
    state.targetOrigin = null;
    state.lastError = sanitizeError(err);
    throw err;
  }

  state.url = url;
  state.status = nextStatus;
  state.tunnel = tunnel;
  state.startedAt = nowIso();
  state.token = randomBytes(32).toString('base64url');
  state.healthSecret = randomBytes(32).toString('base64url');
  state.generation += 1;
  state.lastCheckedAt = null;
  state.lastHealthyAt = null;
  state.lastRemoteError = null;
  state.lastLocalError = null;
  state.consecutiveRemoteFailures = 0;
  state.consecutiveLocalFailures = 0;
  startHealthChecks();

  return { url, token: state.token };
}

export const TunnelService = {
  async start(port: number): Promise<{ url: string; token: string }> {
    return startTunnel(port, 'checking');
  },

  async regenerate(port: number): Promise<{ url: string; token: string }> {
    const nextPort = state.targetPort ?? port;
    this.stop();
    const result = await startTunnel(nextPort, 'linkReplaced');
    const timer = setTimeout(() => {
      if (state.status === 'linkReplaced') {
        state.status = 'checking';
      }
    }, LINK_REPLACED_STATUS_TTL_MS);
    timer.unref?.();
    return result;
  },

  stop(): void {
    const tunnel = state.tunnel;
    resetRuntimeState('stopped');
    if (tunnel) tunnel.stop();
  },

  getStatus(): TunnelStatus {
    return {
      running: state.tunnel !== null,
      status: state.status,
      url: state.url,
      startedAt: state.startedAt,
      targetPort: state.targetPort,
      generation: state.generation,
      lastCheckedAt: state.lastCheckedAt,
      lastHealthyAt: state.lastHealthyAt,
      lastRemoteError: state.lastRemoteError,
      lastLocalError: state.lastLocalError,
      lastExitAt: state.lastExitAt,
      lastExitCode: state.lastExitCode,
      lastExitSignal: state.lastExitSignal,
      lastError: state.lastError,
      lastProcessOutput: state.lastProcessOutput,
      consecutiveRemoteFailures: state.consecutiveRemoteFailures,
      consecutiveLocalFailures: state.consecutiveLocalFailures,
      canRegenerate: state.status !== 'starting',
    };
  },

  getToken(): string | null {
    return state.token;
  },

  validateToken(candidate: string): boolean {
    if (!state.token) return false;
    const a = Buffer.from(state.token);
    const b = Buffer.from(candidate);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },

  validateHealthCheck(check: string | null | undefined, generation: string | null | undefined): boolean {
    if (!state.healthSecret) return false;
    if (!check || !generation) return false;
    if (Number(generation) !== state.generation) return false;

    const a = Buffer.from(state.healthSecret);
    const b = Buffer.from(check);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },

  getHealthResponse() {
    return {
      ok: true,
      generation: state.generation,
      status: state.status,
    };
  },

  isRunning(): boolean {
    return state.tunnel !== null;
  },

  async checkNow(): Promise<void> {
    await runHealthCheck();
  },

  __resetForTests(): void {
    resetRuntimeState('stopped');
    state.generation = 0;
    state.lastExitAt = null;
    state.lastExitCode = null;
    state.lastExitSignal = null;
    state.lastError = null;
    state.lastProcessOutput = null;
  },
};
