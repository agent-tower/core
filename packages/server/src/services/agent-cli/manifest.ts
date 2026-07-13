import type {
  AgentCliCommandSpec,
  AgentCliDownloadedScriptInstallSpec,
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

function shInstaller(
  downloadUrl: string,
  allowedRedirectHosts: string[],
  allowedExactPaths: string[],
  allowedPathPrefixes: string[],
  verifyCommand: AgentCliCommandSpec,
  riskNotes: string[],
  bash = false
): AgentCliDownloadedScriptInstallSpec {
  return {
    downloadUrl,
    allowedRedirectHosts,
    allowedExactPaths,
    allowedPathPrefixes,
    scriptExtension: '.sh',
    interpreter: { command: bash ? '/bin/bash' : '/bin/sh', args: [] },
    fixedArgs: [],
    maxBytes: 1024 * 1024,
    riskNotes,
    verifyCommand,
  };
}

function powershellInstaller(
  downloadUrl: string,
  allowedRedirectHosts: string[],
  allowedExactPaths: string[],
  allowedPathPrefixes: string[],
  verifyCommand: AgentCliCommandSpec,
  riskNotes: string[],
  env?: Record<string, string>
): AgentCliDownloadedScriptInstallSpec {
  return {
    downloadUrl,
    allowedRedirectHosts,
    allowedExactPaths,
    allowedPathPrefixes,
    scriptExtension: '.ps1',
    interpreter: {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
    },
    fixedArgs: [],
    env,
    maxBytes: 1024 * 1024,
    riskNotes,
    verifyCommand,
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
      { label: 'Codex Windows installer', url: 'https://chatgpt.com/codex/install.ps1' },
    ],
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    install: {
      kind: 'downloaded-script',
      platforms: {
        darwin: shInstaller(
          'https://chatgpt.com/codex/install.sh',
          ['chatgpt.com', 'github.com', 'release-assets.githubusercontent.com'],
          ['/codex/install.sh'],
          ['/openai/codex/releases/', '/github-production-release-asset/965415649/'],
          command('codex'),
          [
            '将从 chatgpt.com 下载官方安装脚本并在本机用户环境执行。',
            '安装器可能修改 PATH、shell profile 或用户目录下的 CLI 配置。',
          ],
        ),
        linux: shInstaller(
          'https://chatgpt.com/codex/install.sh',
          ['chatgpt.com', 'github.com', 'release-assets.githubusercontent.com'],
          ['/codex/install.sh'],
          ['/openai/codex/releases/', '/github-production-release-asset/965415649/'],
          command('codex'),
          [
            '将从 chatgpt.com 下载官方安装脚本并在本机用户环境执行。',
            '安装器可能修改 PATH、shell profile 或用户目录下的 CLI 配置。',
          ],
        ),
        win32: powershellInstaller(
          'https://chatgpt.com/codex/install.ps1',
          ['chatgpt.com', 'github.com', 'release-assets.githubusercontent.com'],
          ['/codex/install.ps1'],
          ['/openai/codex/releases/', '/github-production-release-asset/965415649/'],
          command('codex'),
          [
            '将从 chatgpt.com 下载官方 Windows PowerShell 安装脚本并在本机用户环境执行。',
            '安装器可能修改 PATH 或用户目录下的 Codex CLI 配置。',
          ],
          { CODEX_NON_INTERACTIVE: '1' },
        ),
      },
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
      { label: 'Claude Code Windows installer', url: 'https://claude.ai/install.ps1' },
    ],
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    install: {
      kind: 'downloaded-script',
      platforms: {
        darwin: shInstaller(
          'https://claude.ai/install.sh',
          ['claude.ai', 'downloads.claude.ai'],
          ['/install.sh', '/claude-code-releases/bootstrap.sh'],
          [],
          command('claude'),
          [
            '将从 claude.ai 下载官方安装脚本并在本机用户环境执行。',
            '安装器可能修改 PATH、shell profile 或用户目录下的 Claude Code 配置。',
          ],
          true,
        ),
        linux: shInstaller(
          'https://claude.ai/install.sh',
          ['claude.ai', 'downloads.claude.ai'],
          ['/install.sh', '/claude-code-releases/bootstrap.sh'],
          [],
          command('claude'),
          [
            '将从 claude.ai 下载官方安装脚本并在本机用户环境执行。',
            '安装器可能修改 PATH、shell profile 或用户目录下的 Claude Code 配置。',
          ],
          true,
        ),
        win32: powershellInstaller(
          'https://claude.ai/install.ps1',
          ['claude.ai', 'downloads.claude.ai'],
          ['/install.ps1', '/claude-code-releases/bootstrap.ps1'],
          [],
          command('claude'),
          [
            '将从 claude.ai 下载官方 Windows PowerShell 安装脚本并在本机用户环境执行。',
            '安装器可能修改 PATH 或用户目录下的 Claude Code 配置。',
          ],
        ),
      },
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
      { label: 'Cursor Windows installer', url: 'https://cursor.com/install?win32=true' },
    ],
    supportedPlatforms: ['darwin', 'linux', 'win32'],
    install: {
      kind: 'downloaded-script',
      platforms: {
        darwin: shInstaller(
          'https://cursor.com/install',
          ['cursor.com'],
          ['/install'],
          [],
          command('agent'),
          [
            '将从 cursor.com 下载官方安装脚本并在本机用户环境执行。',
            '安装器可能修改 PATH、shell profile 或用户目录下的 Cursor 配置。',
          ],
          true,
        ),
        linux: shInstaller(
          'https://cursor.com/install',
          ['cursor.com'],
          ['/install'],
          [],
          command('agent'),
          [
            '将从 cursor.com 下载官方安装脚本并在本机用户环境执行。',
            '安装器可能修改 PATH、shell profile 或用户目录下的 Cursor 配置。',
          ],
          true,
        ),
        win32: powershellInstaller(
          'https://cursor.com/install?win32=true',
          ['cursor.com'],
          ['/install'],
          [],
          command('agent'),
          [
            '将从 cursor.com 下载官方 Windows PowerShell 安装脚本并在本机用户环境执行。',
            '安装器可能修改 PATH 或用户目录下的 Cursor 配置。',
          ],
        ),
      },
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
        kind: item.install.kind,
        platforms: Object.fromEntries(
          Object.entries(item.install.platforms).map(([platform, spec]) => [
            platform,
            spec
              ? {
                ...spec,
                allowedRedirectHosts: [...spec.allowedRedirectHosts],
                allowedExactPaths: [...spec.allowedExactPaths],
                allowedPathPrefixes: [...spec.allowedPathPrefixes],
                interpreter: { ...spec.interpreter, args: [...spec.interpreter.args] },
                fixedArgs: [...spec.fixedArgs],
                env: spec.env ? { ...spec.env } : undefined,
                riskNotes: [...spec.riskNotes],
                verifyCommand: {
                  ...spec.verifyCommand,
                  args: [...spec.verifyCommand.args],
                },
              }
              : spec,
          ])
        ),
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
