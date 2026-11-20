import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Vite names every file under `assets/` after a hash of its content, so a file
 * at a given URL never changes. Browsers may reuse it without asking again.
 */
export const WEB_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Serves the built web client from `root`.
 *
 * Hashed assets are cached for a year without revalidation. With the default
 * `max-age=0`, every page load and the first open of a lazily loaded view asked
 * the server about each chunk again, one round trip per wave of imports.
 * `index.html` and the other unhashed files keep `max-age=0`, so a deployment
 * is picked up on the next load. Non-API paths fall back to `index.html` for
 * client-side routes.
 */
export async function registerWebStatic(app: FastifyInstance, root: string): Promise<void> {
  const assets = path.join(root, 'assets') + path.sep;
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    wildcard: false,
    // Runs before `send` sets Cache-Control, which keeps a header already set.
    setHeaders(res, filePath) {
      if (filePath.startsWith(assets)) res.setHeader('Cache-Control', WEB_ASSET_CACHE_CONTROL);
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.sendFile('index.html');
  });
}
