import { Tunnel } from 'cloudflared';

interface TunnelState {
  url: string | null;
  running: boolean;
  tunnel: Tunnel | null;
  startedAt: string | null;
}

const state: TunnelState = {
  url: null,
  running: false,
  tunnel: null,
  startedAt: null,
};

export const TunnelService = {
  async start(port: number): Promise<{ url: string }> {
    if (state.running && state.url) {
      return { url: state.url };
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

    t.on('exit', () => {
      state.url = null;
      state.running = false;
      state.tunnel = null;
      state.startedAt = null;
    });

    return { url };
  },

  stop(): void {
    if (!state.tunnel) return;
    state.tunnel.stop();
    state.url = null;
    state.running = false;
    state.tunnel = null;
    state.startedAt = null;
  },

  getStatus() {
    return {
      running: state.running,
      url: state.url,
      startedAt: state.startedAt,
    };
  },
};
