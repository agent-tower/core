import type {
  TeamRunInvalidatedPayload,
  TeamRunInvalidationReason,
  TeamRunInvalidationScope,
} from '@agent-tower/shared/socket';
import type { EventBus } from '../core/event-bus.js';
import { getEventBus } from '../core/container.js';
import { prisma } from '../utils/index.js';

type TeamRunEventBus = Pick<EventBus, 'emit'>;

export interface EmitTeamRunInvalidatedInput {
  teamRunId: string;
  taskId?: string;
  projectId?: string;
  scopes: TeamRunInvalidationScope[];
  reason: TeamRunInvalidationReason;
}

export async function emitTeamRunInvalidated(
  input: EmitTeamRunInvalidatedInput,
  eventBus: TeamRunEventBus = getEventBus()
): Promise<void> {
  const payload: TeamRunInvalidatedPayload = {
    teamRunId: input.teamRunId,
    taskId: input.taskId,
    projectId: input.projectId,
    scopes: input.scopes,
    reason: input.reason,
  };

  if (!payload.taskId || !payload.projectId) {
    const teamRun = await prisma.teamRun.findUnique({
      where: { id: input.teamRunId },
      select: {
        taskId: true,
        task: { select: { projectId: true } },
      },
    });

    if (!teamRun) {
      return;
    }

    payload.taskId ??= teamRun.taskId;
    payload.projectId ??= teamRun.task.projectId;
  }

  eventBus.emit('team-run:invalidated', payload);
}
