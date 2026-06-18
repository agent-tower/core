/**
 * ExecutionEnv - 执行环境
 * 参考 Rust 实现: crates/executors/src/env.rs
 */

import type { ChildProcess } from 'child_process';
import * as path from 'node:path';
import type { CmdOverrides } from './command-builder.js';

export const AGENT_SUBPROCESS_BLOCKED_ENV_KEYS = [
  'DATABASE_URL',
  'AGENT_TOWER_DATABASE_URL',
  'AGENT_TOWER_DATA_DIR',
  'AGENT_TOWER_WEB_DIR',
  'AGENT_TOWER_NODE_RUNTIME',
  'AGENT_TOWER_DESKTOP_RUNTIME_MODE',
  'AGENT_TOWER_MCP_ENTRY',
  'ELECTRON_RUN_AS_NODE',
  'DATA_DIR',
] as const;

export const AGENT_TOWER_MCP_IDENTITY_ENV_KEYS = [
  'AGENT_TOWER_SESSION_ID',
  'AGENT_TOWER_INVOCATION_ID',
  'AGENT_TOWER_TEAM_RUN_ID',
  'AGENT_TOWER_MEMBER_ID',
] as const;

export const AGENT_TOWER_MCP_SERVICE_ENV_KEYS = [
  'AGENT_TOWER_URL',
  'AGENT_TOWER_PORT',
] as const;

const AGENT_SUBPROCESS_EXTERNAL_ENV_BLOCKED_KEYS = new Set<string>([
  ...AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  ...AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  ...AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
]);

export function filterAgentSubprocessExternalEnv(overrides: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!AGENT_SUBPROCESS_EXTERNAL_ENV_BLOCKED_KEYS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * 仓库上下文
 */
export interface RepoContext {
  /** 工作区根目录 */
  workspaceRoot: string;
  /** 仓库名称列表 */
  repoNames: string[];
}

/**
 * 执行环境 - 管理环境变量和仓库上下文
 */
export class ExecutionEnv {
  private vars: Map<string, string> = new Map();
  readonly repoContext: RepoContext;
  readonly commitReminder: boolean;

  constructor(repoContext: RepoContext, commitReminder: boolean = false) {
    this.repoContext = repoContext;
    this.commitReminder = commitReminder;
  }

  /**
   * 创建默认执行环境
   */
  static default(workingDir: string): ExecutionEnv {
    return new ExecutionEnv(
      { workspaceRoot: workingDir, repoNames: [] },
      false
    );
  }

  /**
   * 插入环境变量
   */
  set(key: string, value: string): this {
    this.vars.set(key, value);
    return this;
  }

  /**
   * 获取环境变量
   */
  get(key: string): string | undefined {
    return this.vars.get(key);
  }

  /**
   * 检查是否包含某个环境变量
   */
  has(key: string): boolean {
    return this.vars.has(key);
  }

  /**
   * 合并其他环境变量（传入的会覆盖现有的）
   */
  merge(other: Record<string, string>): this {
    for (const [key, value] of Object.entries(other)) {
      this.vars.set(key, value);
    }
    return this;
  }

  /**
   * 应用 CmdOverrides 中的环境变量
   */
  withProfile(cmd?: CmdOverrides): ExecutionEnv {
    if (cmd?.env) {
      const newEnv = this.clone();
      newEnv.merge(filterAgentSubprocessExternalEnv(cmd.env));
      return newEnv;
    }
    return this;
  }

  /**
   * 克隆当前环境
   */
  clone(): ExecutionEnv {
    const newEnv = new ExecutionEnv(this.repoContext, this.commitReminder);
    for (const [key, value] of this.vars) {
      newEnv.vars.set(key, value);
    }
    return newEnv;
  }

  /**
   * 转换为普通对象
   */
  toObject(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of this.vars) {
      result[key] = value;
    }
    return result;
  }

  /**
   * 获取完整的环境变量（包含 process.env）
   * 过滤掉会阻止 Agent CLI 嵌套启动的环境变量、继承自父进程的
   * TeamRun/MCP 身份变量，以及 Agent Tower 服务自身 DB/data/web 目录变量。
   * TeamRun/MCP 身份变量仍可通过 ExecutionEnv 显式注入到具体 invocation。
   * 当 provider 设置了 ANTHROPIC_* 变量时，清除 process.env 中残留的同类变量，
   * 避免 Claude Code 优先使用错误的认证信息
   */
  getFullEnv(): Record<string, string> {
    const providerVars = this.toObject();
    const hasProviderAnthropicVars = Object.keys(providerVars).some(k => k.startsWith('ANTHROPIC_'));

    const env = {
      ...process.env as Record<string, string>,
    };

    // 如果 provider 设置了任何 ANTHROPIC_* 变量，先清除 process.env 中所有 ANTHROPIC_* 残留
    // 再用 provider 的值覆盖，确保不会混用不同 provider 的认证信息
    if (hasProviderAnthropicVars) {
      for (const key of Object.keys(env)) {
        if (key.startsWith('ANTHROPIC_')) {
          delete env[key];
        }
      }
    }

    for (const key of AGENT_TOWER_MCP_IDENTITY_ENV_KEYS) {
      delete env[key];
    }

    Object.assign(env, providerVars);

    // Claude Code 检测 CLAUDECODE 环境变量来阻止嵌套启动
    delete env.CLAUDECODE;
    for (const key of AGENT_SUBPROCESS_BLOCKED_ENV_KEYS) {
      delete env[key];
    }
    return env;
  }

  /**
   * 获取仓库路径列表
   */
  getRepoPaths(): string[] {
    return this.repoContext.repoNames.map(
      name => path.join(this.repoContext.workspaceRoot, name)
    );
  }
}
