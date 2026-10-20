import { useEffect, useState } from 'react'
import { useIsMutating, useQuery } from '@tanstack/react-query'
import type { ConflictRecoveryIdentityResponse } from '@agent-tower/shared'
import type { ConflictDetails } from '@/components/workspace/GitOperationsDialog'
import { apiClient } from '@/lib/api-client'
import { completeConflictDetails, conflictRecoveryEvent, conflictRecoveryStorageUnavailable, conflictTokenHint, readConflictRecovery } from '@/lib/conflict-recovery-storage'
import { pendingConflictReceiver, pendingConflictSubmission } from './user-submission'
import { queryKeys } from './query-keys'

/** Owns local evidence and its identity-scoped dialog. Opening never writes Git or submits. */
export function useConflictRecovery(workspaceIds: string[], enabled = true) {
  const [, changed] = useState(0)
  const changingIdentity = useIsMutating({ mutationKey: queryKeys.accessAuth.identityChange }) > 0
  const identity = useQuery({
    queryKey: queryKeys.accessAuth.conflictRecoveryIdentity,
    queryFn: ({ signal }) => apiClient.get<ConflictRecoveryIdentityResponse>('/conflict-recovery-identity', { signal }),
    enabled: enabled && !changingIdentity, staleTime: 0, gcTime: 0, retry: false,
  })
  const actor = enabled && !changingIdentity && identity.isSuccess && !identity.isFetching ? identity.data.actor : undefined
  const [dialog, setDialog] = useState<{ actor?: string; enabled: boolean; details?: ConflictDetails }>({ actor, enabled })
  // Also erase memory: re-verifying the same actor must not resurrect an old dialog or override.
  if (dialog.actor !== actor || dialog.enabled !== enabled) setDialog({ actor, enabled })
  useEffect(() => {
    const handler = () => changed(value => value + 1)
    window.addEventListener(conflictRecoveryEvent, handler)
    return () => window.removeEventListener(conflictRecoveryEvent, handler)
  }, [])
  const drafts = actor ? readConflictRecovery(actor).filter(draft => workspaceIds.includes(draft.details.sourceWorkspaceId ?? '')) : []
  const pendingConflictDetails = dialog.enabled === enabled && (!enabled || (actor && dialog.actor === actor)) ? dialog.details ?? null : null
  const openDialog = (input: ConflictDetails) => {
    let details = completeConflictDetails(input)
    if (enabled) {
      if (!actor || (conflictTokenHint(details.resolutionContextToken)?.actor ?? actor) !== actor) return
      const sourceId = details.sourceWorkspaceId
      if (!sourceId || !workspaceIds.includes(sourceId)) return
      const unknown = pendingConflictSubmission(actor, sourceId)
      const saved = drafts.find(draft => draft.details.sourceWorkspaceId === sourceId && pendingConflictReceiver(draft.details.resolutionContextToken))
      // Prefer the atomic original request even when its display draft was explicitly cleared.
      if (unknown) details = completeConflictDetails({ conflictOp: details.conflictOp, conflictedFiles: [], resolutionContextToken: unknown.token })
      else if (saved) details = saved.details
    }
    setDialog({ actor, enabled, details })
  }
  return { drafts, actor, pendingConflictDetails, openDialog, closeDialog: () => setDialog({ actor, enabled }),
    storageUnavailable: conflictRecoveryStorageUnavailable(), identityError: enabled && identity.isError }
}
