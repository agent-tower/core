---
title: Tunnel
description: 从外网访问本机 Agent Tower。
---

# Tunnel

Tunnel 用来把本地 Agent Tower 临时暴露到外网，方便手机或其他设备访问。

## 接口

| 接口 | 作用 |
| --- | --- |
| `GET /api/tunnel/status` | 查看当前 tunnel 状态 |
| `POST /api/tunnel/bootstrap` | 前端启动时用 token 换取 session cookie |
| `POST /api/tunnel/start` | 启动 tunnel |
| `POST /api/tunnel/stop` | 停止 tunnel |

## 状态返回

本地请求会返回：

- tunnel 状态
- token
- shareableUrl

## 使用建议

- 只在需要远程查看时开启
- 关闭后再继续本地开发
- 不要把公开链接长期暴露给不信任的人
