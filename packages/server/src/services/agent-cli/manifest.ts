import type {
  AgentCliCommandSpec,
  AgentCliInstallManifestItem,
  AgentCliPlatform,
  AgentCliToolId,
} from '@agent-tower/shared';
import { validateAgentCliManifest } from './manifest-validator.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

function command(
  name: string,
  args: string[] = ['--version'],
  versionPattern = String.raw`\d+(?:\.\d+){1,3}`
): AgentCliCommandSpec {
  return {
    command: name,
    args,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    versionPattern,
  };
}

export const AGENT_CLI_MANIFEST: readonly AgentCliInstallManifestItem[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    description: 'OpenAI Codex CLI',
    legacy: false,
    officialSources: [
      { label: 'Codex installer', url: 'https://chatgpt.com/codex/install.sh' },
    ],
    supportedPlatforms: ['darwin', 'linux'],
    install: {
      kind: 'downloaded-script',
      downloadUrl: 'https://chatgpt.com/codex/install.sh',
      allowedRedirectHosts: ['chatgpt.com'],
      allowedExactPaths: ['/codex/install.sh'],
      allowedPathPrefixes: [],
      interpreters: {
        darwin: { command: '/bin/sh', args: [] },
        linux: { command: '/bin/sh', args: [] },
      },
      fixedArgs: [],
      maxBytes: 1024 * 1024,
      riskNotes: [
        '将从 chatgpt.com 下载官方安装脚本并在本机用户环境执行。',
        '安装器可能修改 PATH、shell profile 或用户目录下的 CLI 配置。',
      ],
      verifyCommand: command('codex'),
    },
    detectionCommands: [command('codex')],
    versionCommand: command('codex'),
    authCommand: {
      command: 'codex',
      args: ['login', 'status'],
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
    lastVerifiedAt: '2026-06-18',
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
    legacy: false,
    officialSources: [
      { label: 'Claude Code installer', url: 'https://claude.ai/install.sh' },
    ],
    supportedPlatforms: ['darwin', 'linux'],
    install: {
      kind: 'downloaded-script',
      downloadUrl: 'https://claude.ai/install.sh',
      allowedRedirectHosts: ['claude.ai'],
      allowedExactPaths: ['/install.sh'],
      allowedPathPrefixes: [],
      interpreters: {
        darwin: { command: '/bin/bash', args: [] },
        linux: { command: '/bin/bash', args: [] },
      },
      fixedArgs: [],
      maxBytes: 1024 * 1024,
      riskNotes: [
        '将从 claude.ai 下载官方安装脚本并在本机用户环境执行。',
        '安装器可能修改 PATH、shell profile 或用户目录下的 Claude Code 配置。',
      ],
      verifyCommand: command('claude'),
    },
    detectionCommands: [command('claude')],
    versionCommand: command('claude'),
    authCommand: {
      command: 'claude',
      args: ['doctor'],
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
    lastVerifiedAt: '2026-06-18',
  },
  {
    id: 'cursor-agent',
    displayName: 'Cursor CLI Agent',
    description: 'Cursor Agent command line interface',
    legacy: false,
    officialSources: [
      { label: 'Cursor installer', url: 'https://cursor.com/install' },
    ],
    supportedPlatforms: ['darwin', 'linux'],
    install: {
      kind: 'downloaded-script',
      downloadUrl: 'https://cursor.com/install',
      allowedRedirectHosts: ['cursor.com'],
      allowedExactPaths: ['/install'],
      allowedPathPrefixes: [],
      interpreters: {
        darwin: { command: '/bin/bash', args: [] },
        linux: { command: '/bin/bash', args: [] },
      },
      fixedArgs: [],
      maxBytes: 1024 * 1024,
      riskNotes: [
        '将从 cursor.com 下载官方安装脚本并在本机用户环境执行。',
        '安装器可能修改 PATH、shell profile 或用户目录下的 Cursor 配置。',
      ],
      verifyCommand: command('agent'),
    },
    detectionCommands: [command('agent'), command('cursor-agent')],
    versionCommand: command('agent'),
    authCommand: {
      command: 'agent',
      args: ['--version'],
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
    lastVerifiedAt: '2026-06-18',
  },
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    description: 'Legacy Gemini CLI detection only',
    legacy: true,
    officialSources: [
      { label: 'Gemini CLI repository', url: 'https://github.com/google-gemini/gemini-cli' },
    ],
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    install: {
      kind: 'detect-only',
      reason: 'Gemini CLI 首版只检测已安装状态，不默认新装。',
    },
    detectionCommands: [command('gemini')],
    versionCommand: command('gemini'),
    lastVerifiedAt: '2026-06-18',
  },
] as const;

validateAgentCliManifest(AGENT_CLI_MANIFEST);

export function getAgentCliManifest(): AgentCliInstallManifestItem[] {
  return AGENT_CLI_MANIFEST.map((item) => ({
    ...item,
    officialSources: item.officialSources.map((source) => ({ ...source })),
    supportedPlatforms: [...item.supportedPlatforms],
    detectionCommands: item.detectionCommands.map((spec) => ({
      ...spec,
      args: [...spec.args],
    })),
    versionCommand: item.versionCommand
      ? { ...item.versionCommand, args: [...item.versionCommand.args] }
      : undefined,
    authCommand: item.authCommand
      ? { ...item.authCommand, args: [...item.authCommand.args] }
      : undefined,
    install: item.install.kind === 'downloaded-script'
      ? {
        ...item.install,
        allowedRedirectHosts: [...item.install.allowedRedirectHosts],
        allowedExactPaths: [...item.install.allowedExactPaths],
        allowedPathPrefixes: [...item.install.allowedPathPrefixes],
        fixedArgs: [...item.install.fixedArgs],
        riskNotes: [...item.install.riskNotes],
        interpreters: { ...item.install.interpreters },
        verifyCommand: {
          ...item.install.verifyCommand,
          args: [...item.install.verifyCommand.args],
        },
      }
      : { ...item.install },
  }));
}

export function getAgentCliManifestItem(toolId: AgentCliToolId): AgentCliInstallManifestItem | null {
  return getAgentCliManifest().find((item) => item.id === toolId) ?? null;
}

export function getServerAgentCliPlatform(
  platform: NodeJS.Platform = process.platform
): AgentCliPlatform | null {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  return null;
}
