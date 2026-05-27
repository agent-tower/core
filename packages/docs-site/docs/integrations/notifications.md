---
title: 通知
description: OS 通知和飞书 webhook。
---

# 通知

Agent Tower 支持在任务进入 `IN_REVIEW` 时发出通知。

## 支持的通知渠道

- OS 通知
- 飞书 webhook

## 配置接口

| 接口 | 作用 |
| --- | --- |
| `GET /api/notifications/settings` | 获取通知配置 |
| `PUT /api/notifications/settings` | 更新通知配置 |
| `POST /api/notifications/test` | 测试第三方通知渠道 |

## 常见字段

| 字段 | 说明 |
| --- | --- |
| `osNotificationEnabled` | 是否启用系统通知 |
| `thirdPartyChannel` | 当前第三方渠道，暂时支持 `none` 和 `feishu` |
| `feishuWebhookUrl` | 飞书 webhook 地址 |
| `thirdPartyBaseUrl` | 用于通知消息中的回链地址 |
| `taskInReviewTitleTemplate` | 进入审查时的标题模板 |
| `taskInReviewBodyTemplate` | 进入审查时的正文模板 |

## 使用建议

- 先在本机测试通知是否能正常到达
- 飞书 webhook 不要硬编码进公开仓库
- 如果通知文本需要带回链，确保 `thirdPartyBaseUrl` 能从手机或桌面端正确访问
