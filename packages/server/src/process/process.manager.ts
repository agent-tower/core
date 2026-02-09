import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

export class ProcessManager {
  private processes = new Map<string, IPty>();

  track(sessionId: string, p: IPty): void {
    this.processes.set(sessionId, p);

    p.onExit(() => {
      // Only delete if this is still the tracked process (avoids race when PTY is replaced)
      if (this.processes.get(sessionId) === p) {
        this.processes.delete(sessionId);
      }
    });
  }

  /**
   * 创建独立终端 PTY 实例
   * @param terminalId 终端标识符
   * @param workingDir 工作目录
   * @returns 创建的 IPty 实例
   */
  spawn(terminalId: string, workingDir: string): IPty {
    const shell = process.env.SHELL || '/bin/bash';
    const p = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: workingDir,
      env: process.env as Record<string, string>,
    });

    this.processes.set(terminalId, p);

    p.onExit(() => {
      this.processes.delete(terminalId);
    });

    return p;
  }

  write(sessionId: string, data: string): void {
    const p = this.processes.get(sessionId);
    if (p) {
      p.write(data + '\n');
    }
  }

  kill(sessionId: string): void {
    const p = this.processes.get(sessionId);
    if (p) {
      p.kill();
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
