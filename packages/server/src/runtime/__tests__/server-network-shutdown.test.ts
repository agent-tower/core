import Fastify from 'fastify';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { trackUpgradedConnections } from '../server-network-shutdown.js';

describe('server upgrade shutdown', () => {
  it('reaches onClose while an upgraded client remains connected', async () => {
    const app = Fastify();
    const closeUpgrades = trackUpgradedConnections(app.server);
    app.addHook('preClose', async () => { closeUpgrades(); });
    let onCloseEntered = false;
    app.addHook('onClose', async () => { onCloseEntered = true; });
    app.server.on('upgrade', (_request, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener address');
    const client = createConnection(address.port, '127.0.0.1');
    try {
      await once(client, 'connect');
      const upgraded = once(client, 'data');
      client.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
      await upgraded;
      expect(client.destroyed).toBe(false);
      await app.close();
      expect(onCloseEntered).toBe(true);
    } finally {
      client.destroy();
      closeUpgrades();
      await app.close();
    }
  }, 5_000);
});
