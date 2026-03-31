/**
 * 通知配置 API
 *
 * GET  /api/notifications/settings       — 获取通知配置
 * PUT  /api/notifications/settings       — 更新通知配置
 * POST /api/notifications/test           — 测试第三方通知渠道
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/index.js';
import { getNotificationService } from '../core/container.js';
import { getDefaultNotificationSettings } from '../services/notifications/defaults.js';

const updateSettingsSchema = z.object({
  osNotificationEnabled: z.boolean().optional(),
  thirdPartyChannel: z.enum(['none', 'feishu']).optional(),
  feishuWebhookUrl: z.string().nullable().optional(),
  thirdPartyBaseUrl: z.string().nullable().optional(),
  taskInReviewTitleTemplate: z.string().optional(),
  taskInReviewBodyTemplate: z.string().optional(),
});

const testChannelSchema = z.object({
  channel: z.enum(['feishu']),
  webhookUrl: z.string().url(),
  baseUrl: z.string().optional(),
});

export async function notificationRoutes(app: FastifyInstance) {
  // 获取通知配置
  app.get('/notifications/settings', async () => {
    const service = getNotificationService();
    return service.getSettings();
  });

  // 更新通知配置
  app.put('/notifications/settings', async (request) => {
    const data = updateSettingsSchema.parse(request.body);
    const appSettings = await prisma.appSettings.findUnique({
      where: { id: 'singleton' },
    });
    const defaults = getDefaultNotificationSettings(appSettings?.locale === 'en' ? 'en' : 'zh-CN');
    const settings = await prisma.notificationSettings.upsert({
      where: { id: 'singleton' },
      create: { ...defaults, ...data },
      update: data,
    });
    return settings;
  });

  // 测试第三方通知
  app.post('/notifications/test', async (request, reply) => {
    const { channel, webhookUrl, baseUrl } = testChannelSchema.parse(request.body);
    try {
      const service = getNotificationService();
      await service.testChannel(channel, webhookUrl, baseUrl);
      return { success: true };
    } catch (e) {
      reply.code(400);
      return { error: e instanceof Error ? e.message : 'Test failed' };
    }
  });
}
