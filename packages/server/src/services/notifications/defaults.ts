import type { AppLocale, NotificationSettings } from '@agent-tower/shared';

export function getDefaultNotificationSettings(locale: AppLocale = 'zh-CN'): NotificationSettings {
  if (locale === 'en') {
    return {
      id: 'singleton',
      osNotificationEnabled: true,
      thirdPartyChannel: 'none',
      feishuWebhookUrl: null,
      thirdPartyBaseUrl: null,
      taskInReviewTitleTemplate: 'Agent Tower',
      taskInReviewBodyTemplate: '✅ "{taskTitle}" is complete and ready for review',
    };
  }

  return {
    id: 'singleton',
    osNotificationEnabled: true,
    thirdPartyChannel: 'none',
    feishuWebhookUrl: null,
    thirdPartyBaseUrl: null,
    taskInReviewTitleTemplate: 'Agent Tower',
    taskInReviewBodyTemplate: '✅ "{taskTitle}" 已完成，等待审查',
  };
}
