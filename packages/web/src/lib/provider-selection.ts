import type { ProviderWithAvailability } from '@/hooks/use-providers'

/** Disabled configurations stay available for history, but are excluded from Provider choice lists. */
export function isProviderEnabled(item: Pick<ProviderWithAvailability, 'provider'>): boolean {
  return item.provider.enabled !== false
}
