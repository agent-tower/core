import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type CliDuplexEvent =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'eof' }
  | { type: 'disconnected'; error: Error };
export interface CliDuplexIO {
  /** Single reader; replays bounded output received before the driver attached. */
  subscribe(listener: (event: CliDuplexEvent) => void): () => void;
  write(data: string, isCurrent?: () => boolean): Promise<void>;
  end(): Promise<void>;
  close(): void;
}
const MAX_FRAME = 16 * 1024 * 1024;
const DEADLINE_MS = 10_000;

/** Private launch-scoped IPC. Agent stdio never travels through the terminal PTY. */
export async function createCliDuplexChannel(): Promise<CliDuplexIO & { configFile: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-duplex-'));
  await chmod(dir, 0o700);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\tower-duplex-${randomUUID()}` : path.join(dir, 'io.sock');
  const secret = randomUUID();
  let socket: Socket | undefined;
  let listener: ((event: CliDuplexEvent) => void) | undefined;
  type OutputEvent = CliDuplexEvent | { type: 'output_complete' };
  let events: OutputEvent[] = [];
  let buffered = 0;
  let failure: Error | undefined;
  let ended = false;
  let outputConsumed = false;
  let seq = 0;
  let serial: Promise<void> = Promise.resolve();
  let connected!: () => void;
  let rejectConnection!: (error: Error) => void;
  const connection = new Promise<void>((resolve, reject) => { connected = resolve; rejectConnection = reject; });
  void connection.catch(() => undefined);
  const connectionTimer = setTimeout(() => fail(new Error('CLI I/O connection timed out')), DEADLINE_MS);
  const pending = new Map<number, { resolve(): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  const deliver = (event: OutputEvent) => {
    if (event.type === 'output_complete') {
      outputConsumed = true;
      socket?.write(JSON.stringify({ type: 'output_consumed' }) + '\n');
    } else listener?.(event);
  };
  const emit = (event: OutputEvent) => {
    if (listener) deliver(event);
    else {
      buffered += 'data' in event ? Buffer.byteLength(event.data) : 0;
      if (buffered > MAX_FRAME) { fail(new Error('CLI early output exceeded its limit')); return; }
      events.push(event);
    }
  };
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    clearTimeout(connectionTimer); rejectConnection(error); buffered = 0;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    socket?.destroy();
    emit({ type: 'disconnected', error });
  };
  const server = createServer(candidate => {
    if (socket || failure) { candidate.destroy(); return; }
    let authenticated = false;
    let buffer = '';
    candidate.setEncoding('utf8');
    candidate.on('error', () => { if (authenticated) fail(new Error('CLI I/O failed')); });
    candidate.on('close', () => { if (authenticated && !outputConsumed) fail(new Error('CLI I/O disconnected')); });
    candidate.on('data', (data: string) => {
      buffer += data;
      if (buffer.length > MAX_FRAME) { candidate.destroy(); if (authenticated) fail(new Error('CLI I/O frame exceeded its limit')); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (!authenticated) {
            if (frame.type !== 'hello' || frame.secret !== secret) { candidate.destroy(); return; }
            authenticated = true; socket = candidate; clearTimeout(connectionTimer); connected(); continue;
          }
          if (frame.type === 'ack') {
            const item = pending.get(frame.id);
            if (!item) continue;
            pending.delete(frame.id); clearTimeout(item.timer);
            if (frame.error) { const error = new Error('CLI stdin write failed'); item.reject(error); fail(error); }
            else item.resolve();
          } else if ((frame.type === 'stdout' || frame.type === 'stderr') && typeof frame.data === 'string') {
            emit({ type: frame.type, data: frame.data });
          } else if (frame.type === 'eof') emit({ type: 'eof' });
          else if (frame.type === 'output_complete') emit({ type: 'output_complete' });
          else throw new Error('Invalid CLI I/O frame');
        } catch { fail(new Error('Invalid CLI I/O frame')); return; }
      }
    });
    const authTimer = setTimeout(() => { if (!authenticated) candidate.destroy(); }, DEADLINE_MS);
    authTimer.unref(); candidate.once('close', () => clearTimeout(authTimer));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    if (process.platform !== 'win32') await chmod(endpoint, 0o600);
    const configFile = path.join(dir, 'launch.json');
    await writeFile(configFile, JSON.stringify({ endpoint, secret }), { mode: 0o600 });
    const send = (type: 'write' | 'end', data?: string, isCurrent?: () => boolean): Promise<void> => {
      const operation = serial.then(async () => {
        await connection;
        if (failure) throw failure;
        if (outputConsumed) throw new Error('CLI output has ended');
        if (isCurrent && !isCurrent()) throw new Error('CLI request is no longer active');
        if (ended) throw new Error('CLI stdin has ended');
        if (!socket || socket.destroyed) throw new Error('CLI I/O is not connected');
        if (type === 'end') ended = true;
        const id = ++seq;
        const frame = JSON.stringify({ type, id, data }) + '\n';
        if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('CLI input exceeded its limit');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => fail(new Error('CLI stdin write timed out')), DEADLINE_MS);
          pending.set(id, { resolve, reject, timer });
          socket!.write(frame, error => { if (error) fail(new Error('CLI stdin write failed')); });
        });
      });
      serial = operation.catch(() => undefined);
      return operation;
    };
    return {
      configFile,
      subscribe(next) {
        if (listener) throw new Error('CLI I/O already has a reader');
        listener = next;
        const early = events; events = []; buffered = 0;
        for (const event of early) deliver(event);
        return () => { if (listener === next) listener = undefined; };
      },
      write: (data, current) => send('write', data, current),
      end: () => send('end'),
      close() {
        fail(new Error('CLI I/O closed'));
        server.close();
        void rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) { server.close(); await rm(dir, { recursive: true, force: true }); throw error; }
}
