import { prisma } from '../../utils/index.js';
import { OSNotificationChannel } from './os-channel.js';
import { FeishuChannel } from './feishu-channel.js';
import type { NotificationEvent } from './types.js';
import type { NotificationSettings } from '@agent-tower/shared';

export class NotificationService {
  private osChannel = new OSNotificationChannel();

  async notify(event: NotificationEvent): Promise<void> {
    const settings = await this.getSettings();

    // 渲染模板
    const rendered = this.renderTemplate(event, settings);

    const sends: Promise<void>[] = [];

    if (settings.osNotificationEnabled) {
      sends.push(this.osChannel.send({
        ...event,
        title: rendered.title,
        body: rendered.body,
      }));
    }

    if (settings.thirdPartyChannel === 'feishu' && settings.feishuWebhookUrl) {
      sends.push(new FeishuChannel(
        settings.feishuWebhookUrl,
        settings.thirdPartyBaseUrl ?? undefined,
      ).send({
        ...event,
        title: rendered.title,
        body: rendered.body,
      }));
    }

    if (sends.length === 0) return;

    const results = await Promise.allSettled(sends);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[NotificationService] Channel failed:', result.reason);
      }
    }
  }

  private renderTemplate(event: NotificationEvent, settings: NotificationSettings): { title: string; body: string } {
    let title = event.title;
    let body = event.body;

    if (event.type === 'task_in_review') {
      title = settings.taskInReviewTitleTemplate || event.title;
      body = settings.taskInReviewBodyTemplate || event.body;
    }

    // 模板变量替换
    const vars = {
      taskTitle: event.metadata?.taskTitle as string || '',
      taskId: event.metadata?.taskId as string || '',
      projectId: event.metadata?.projectId as string || '',
      projectName: event.metadata?.projectName as string || '',
      status: event.metadata?.status as string || '',
    };

    for (const [key, value] of Object.entries(vars)) {
      const pattern = new RegExp(`\\{${key}\\}`, 'g');
      title = title.replace(pattern, value);
      body = body.replace(pattern, value);
    }

    return { title, body };
  }

  async getSettings(): Promise<NotificationSettings> {
    const settings = await prisma.notificationSettings.findUnique({
      where: { id: 'singleton' },
    });
    return (settings ?? {
      id: 'singleton',
      osNotificationEnabled: true,
      thirdPartyChannel: 'none',
      feishuWebhookUrl: null,
      thirdPartyBaseUrl: null,
      taskInReviewTitleTemplate: 'Agent Tower',
      taskInReviewBodyTemplate: '✅ "{taskTitle}" 已完成，等待审查',
    }) as NotificationSettings;
  }

  async testChannel(channel: string, webhookUrl: string, baseUrl?: string): Promise<void> {
    if (channel === 'feishu') {
      const feishu = new FeishuChannel(webhookUrl, baseUrl);
      await feishu.send({
        type: 'task_in_review',
        title: 'Agent Tower 测试通知',
        body: '🎉 飞书通知配置成功！点击下方按钮可跳转到任务页面。',
        metadata: { taskId: 'test-task-id', projectId: 'test-project-id' },
      });
    } else {
      throw new Error(`Unknown channel: ${channel}`);
    }
  }
}
