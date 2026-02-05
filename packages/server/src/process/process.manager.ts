import type { IPty } from 'node-pty';

export class ProcessManager {
  private processes = new Map<string, IPty>();

  track(sessionId: string, pty: IPty): void {
    this.processes.set(sessionId, pty);

    pty.onExit(() => {
      this.processes.delete(sessionId);
    });
  }

  write(sessionId: string, data: string): void {
    const pty = this.processes.get(sessionId);
    if (pty) {
      pty.write(data + '\n');
    }
  }

  kill(sessionId: string): void {
    const pty = this.processes.get(sessionId);
    if (pty) {
      pty.kill();
      this.processes.delete(sessionId);
    }
  }

  get(sessionId: string): IPty | undefined {
    return this.processes.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }
}
