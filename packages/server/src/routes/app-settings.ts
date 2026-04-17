import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppLocale, AppSettings } from '@agent-tower/shared';
import { prisma } from '../utils/index.js';
import { DEFAULT_COMMIT_MESSAGE_PROMPT } from '../services/commit-message.service.js';

const localeSchema = z.enum(['zh-CN', 'en']);

const updateAppSettingsSchema = z.object({
  locale: localeSchema.optional(),
  commitMessageProviderId: z.string().nullable().optional(),
  commitMessagePrompt: z.string().nullable().optional(),
});

function getDefaultAppSettings(): AppSettings {
  return {
    id: 'singleton',
    locale: null,
    commitMessageProviderId: null,
    commitMessagePrompt: null,
  };
}

export async function appSettingsRoutes(app: FastifyInstance) {
  app.get('/app-settings', async () => {
    const settings = await prisma.appSettings.findUnique({
      where: { id: 'singleton' },
    });

    if (settings) {
      return settings as AppSettings;
    }

    return getDefaultAppSettings();
  });

  app.put('/app-settings', async (request) => {
    const data = updateAppSettingsSchema.parse(request.body);

    const updateData: Record<string, unknown> = {};
    if (data.locale !== undefined) {
      updateData.locale = (data.locale ?? null) as AppLocale | null;
    }
    if (data.commitMessageProviderId !== undefined) {
      updateData.commitMessageProviderId = data.commitMessageProviderId;
    }
    if (data.commitMessagePrompt !== undefined) {
      updateData.commitMessagePrompt = data.commitMessagePrompt;
    }

    const settings = await prisma.appSettings.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        ...updateData,
      },
      update: updateData,
    });

    return settings as AppSettings;
  });

  app.get('/app-settings/commit-message-defaults', async () => {
    return { prompt: DEFAULT_COMMIT_MESSAGE_PROMPT };
  });
}
