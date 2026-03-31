import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppLocale, AppSettings } from '@agent-tower/shared';
import { prisma } from '../utils/index.js';

const localeSchema = z.enum(['zh-CN', 'en']);

const updateAppSettingsSchema = z.object({
  locale: localeSchema.optional(),
});

function getDefaultAppSettings(): AppSettings {
  return {
    id: 'singleton',
    locale: null,
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
    const locale = (data.locale ?? null) as AppLocale | null;

    const settings = await prisma.appSettings.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        locale,
      },
      update: {
        locale,
      },
    });

    return settings as AppSettings;
  });
}
