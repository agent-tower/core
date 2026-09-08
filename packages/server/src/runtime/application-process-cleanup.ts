type ProcessCleanup = () => Promise<unknown> | unknown;
let stopping = false;

export function beginApplicationProcessShutdown(): void { stopping = true; }

export function assertApplicationProcessStartAllowed(): void {
  if (stopping) throw new Error('Application process shutdown is in progress');
}

// Route-local owners (such as preview gateways) must remain reachable after
// Fastify's one-shot onClose hooks have failed.
const registeredOwners = new Set<ProcessCleanup>();

export function registerApplicationProcessCleanup(cleanup: ProcessCleanup): () => void {
  registeredOwners.add(cleanup);
  return () => { registeredOwners.delete(cleanup); };
}

export async function cleanupApplicationProcessOwners(owners: ProcessCleanup[] = []): Promise<void> {
  const results = await Promise.allSettled(
    [...owners, ...registeredOwners].map(async (cleanup) => cleanup()),
  );
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Application process cleanup is still pending');
}
