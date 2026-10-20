import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './query-keys'

let generation = 0
export const roomTranslationAccessGeneration = () => generation

/** Advance synchronously, before any cancelled request or identity await settles. */
export async function clearRoomTranslationAccess(client: QueryClient) {
  generation++
  const cancelled = client.cancelQueries({ queryKey: queryKeys.roomTranslations.all })
  client.removeQueries({ queryKey: queryKeys.roomTranslations.all })
  await cancelled
}
