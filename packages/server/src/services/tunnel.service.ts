import { Tunnel } from 'cloudflared';
import { randomBytes, timingSafeEqual } from 'node:crypto';

interface TunnelState {
  url: string | null;
  running: boolean;
  tunnel: Tunnel | null;
  startedAt: string | null;
  token: string | null;
}

const state: TunnelState = {
  url: null,
  running: false,
  tunnel: null,
  startedAt: null,
  token: null,
};

export const TunnelService = {
  async start(port: number): Promise<{ url: string; token: string }> {
    if (state.running && state.url && state.token) {
      return { url: state.url, token: state.token };
    }

    const t = Tunnel.quick(`http://localhost:${port}`);

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        t.stop();
        reject(new Error('Tunnel startup timed out (30s)'));
      }, 30000);

      t.once('url', (url) => {
        clearTimeout(timeout);
        resolve(url);
      });

      t.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    state.url = url;
    state.running = true;
    state.tunnel = t;
    state.startedAt = new Date().toISOString();
    state.token = randomBytes(32).toString('base64url');

    t.on('exit', () => {
      state.url = null;
      state.running = false;
      state.tunnel = null;
      state.startedAt = null;
      state.token = null;
    });

    return { url, token: state.token };
  },

  stop(): void {
    if (!state.tunnel) return;
    state.tunnel.stop();
    state.url = null;
    state.running = false;
    state.tunnel = null;
    state.startedAt = null;
    state.token = null;
  },

  getStatus() {
    return {
      running: state.running,
      url: state.url,
      startedAt: state.startedAt,
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

  isRunning(): boolean {
    return state.running;
  },
};
