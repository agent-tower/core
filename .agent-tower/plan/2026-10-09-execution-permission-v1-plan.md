# 三档执行权限首版实施与验收

- 日期：2026-10-09
- 状态：实现与验证完成；独立审查与界面验收待负责人安排。
- 权威范围：Team Room 决策 `d8872173-ea25-4992-83b6-c6d42a163f1a` 与派活 `dd597dac-55c7-4646-ad7e-abdaeb2569c3`。
- 原方案与审查仅作背景，重型多用户安全治理不纳入首版。

## 范围

1. Provider 顶层 `executionPermission` 是新配置唯一权限选择，三项为 `ASK / AUTO_SANDBOX / FULL_ACCESS`；贯通 shared、server、web、默认值、profiles 和备份导入导出。
2. 集中兼容旧两档和危险布尔开关：危险值对应完全访问；有歧义或能力缺失保留可读配置并提示重选，绝不自动升权。首次写入保留旧文件备份。
3. CLI/ACP Definition/Executor 负责原生投影。首先实现 Codex ACP 三档，以安装适配器代码和官方说明核实其他组合；未核实组合固定置灰并给出理由。
4. 原生审批沿现有通道转发，沙箱档不由通用 Driver 自动 allow；原生计划交互照协议处理。沙箱、风险判断和失效处理遵循 Agent 自身规则。
5. 修改在新 runtime 启动/重启生效；活动 runtime 复用保留启动模式，runtime DTO/UI 展示此模式。新 transport 的 resume/load 显式配置当前模式，协商不支持则报错。
6. 服务端档位策略接口默认允许所有支持项；可注入受限策略。保存、测试和实际新启动均检查支持/授权，适配器不理解角色。
7. CLI/ACP 共用三项权限组件，禁用项说明可读、键盘不可选择；失效已选值可见，禁止保存/启动；支持 i18n。

不建设用户库/RBAC、跨任务身份持久化、外层隔离、即时撤权、逐工具资源授权审计或全面升权检测；不合并、发布。

## 实施顺序

1. 集中兼容读取与 shared DTO、服务端支持矩阵/允许档位接口、Provider 持久入口。
2. Runtime 启动快照与执行支持校验；Codex ACP 纵向三档，再逐项完成其他原生投影。
3. 统一 UI、启动模式显示、导入/默认/profile 回归。
4. 运行邻近契约/行为测试及 shared → server → web 构建，更新公开文档和 runtime/security references。

## 验收

- 三项固定返回；服务端计算支持性与授权交集，同一原因供保存/启动/UI 使用。
- 原始危险字段不能覆盖规范选择；非法/冲突配置明确拒绝。
- 旧 `UNRESTRICTED / AUTO_APPROVE / true` 保持完全访问。独立审查修订：Codex 旧 CLI 安全分支、旧 ACP ASK/缺省均要求明确重选，Pi 旧 ASK 不伪装成安全审批；其他 Agent 沿用各自旧 ACP ASK 语义。旧 Codex ACP 未设置 mode、使用 adapter 默认，不能由标签推断人工 reviewer。
- Codex ACP `read-only / agent / agent-full-access` 显式协商，并检查广告能力；不能从 mode ID 猜沙箱。
- 新启动、resume/load 使用规范模式；同 ID 修改 Provider 后复用仍显示/保持旧启动模式，重启使用新模式。
- 沙箱档剩余审批、人机交互、迟到/取消失效遵循原有协议链路。
- 受限策略禁止直接启动 FULL_ACCESS，能力响应显示禁用；Pi 无 FULL_ACCESS 时没有可运行项。
- UI 禁用项不可鼠标/键盘选中，已失效值不自动替换；CLI/ACP、切换 Agent/runtime、英文文案均覆盖。
- 测试采用临时资源与有界命令；真实模型 smoke 未覆盖项如实列出；长期服务只用 workspace service MCP。

最终 result 列出支持/置灰矩阵、文件与版本定位、验证证据及剩余缺口，交负责人安排独立审查。
