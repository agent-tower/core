import type { FastifyRequest } from 'fastify';
/** Internal clients must explicitly attest user intent; hosted Agent credentials never can. */
export function isUserInput(request: FastifyRequest): boolean {
  if (request.agentTowerAuthKind === 'agent') return false;
  return request.agentTowerAuthKind !== 'internal' || request.headers['x-agent-tower-input-origin'] === 'user';
}
