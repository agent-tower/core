import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';

/** Node server.close() does not close upgraded (Socket.IO/preview) sockets. */
export function trackUpgradedConnections(server: Server): () => void {
  const sockets = new Set<Duplex>();
  let closing = false;
  const onUpgrade = (_request: unknown, socket: Duplex) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('upgrade', onUpgrade);
  server.once('close', () => server.off('upgrade', onUpgrade));
  return () => {
    closing = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}
