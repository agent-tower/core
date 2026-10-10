import { createRequire } from 'node:module';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { AgentType, resolveProviderExecutionPermission } from '@agent-tower/shared';
import { which } from '../../../utils/index.js';
import { AgentRuntimeError } from '../../errors.js';
import { isExecutableFile, resolveBundledClaudeExecutable } from './executable-resolution.js';
import type { AcpAgentDefinition, AcpAgentProfile } from './types.js';

const require = createRequire(import.meta.url);

function parseSettings(settings: string | undefined): Record<string, unknown> {
  if (!settings?.trim()) return {};
  try {
    const parsed = JSON.parse(settings) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new AgentRuntimeError(
      'provider_config_invalid',
      'provider_config',
      'Claude Code Provider settings must be a JSON object',
      false,
      { cause: error },
    );
  }
}

function projectClaudeProvider(
  provider: Parameters<AcpAgentDefinition['projectProvider']>[0],
  inheritedEnvironment: Record<string, string>,
): AcpAgentProfile {
  const settings = parseSettings(provider?.settings);
  const settingsEnv = settings.env;
  const configuredEnv = settingsEnv && typeof settingsEnv === 'object' && !Array.isArray(settingsEnv)
    ? Object.fromEntries(Object.entries(settingsEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {};
  const environment = { ...inheritedEnvironment };
  if (
    Object.keys(provider?.env ?? {}).some(key => key.startsWith('ANTHROPIC_'))
    || Object.keys(configuredEnv).some(key => key.startsWith('ANTHROPIC_'))
  ) {
    for (const key of Object.keys(environment)) {
      if (key.startsWith('ANTHROPIC_')) delete environment[key];
    }
  }
  Object.assign(environment, configuredEnv, provider?.env ?? {});

  const model = typeof provider?.config.model === 'string' && provider.config.model.trim()
    ? provider.config.model.trim()
    : undefined;
  const effort = typeof provider?.config.effort === 'string' && provider.config.effort.trim()
    ? provider.config.effort.trim()
    : undefined;
  if (model) environment.ANTHROPIC_MODEL = model;
  const appendPrompt = typeof provider?.config.appendPrompt === 'string' && provider.config.appendPrompt
    ? provider.config.appendPrompt
    : undefined;
  const permissionMode = resolveProviderExecutionPermission(provider ?? { agentType: AgentType.CLAUDE_CODE }).mode;
  return {
    agentType: AgentType.CLAUDE_CODE,
    environment,
    permissionMode,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(appendPrompt ? { appendPrompt } : {}),
    settings,
  };
}

async function resolveClaudePath(environment: NodeJS.ProcessEnv): Promise<string | null> {
  for (const key of ['CLAUDE_PATH', 'CLAUDE_CODE_EXECUTABLE']) {
    const configured = environment[key]?.trim();
    if (!configured) continue;
    if (path.isAbsolute(configured)) {
      if (await isExecutableFile(configured)) return configured;
      continue;
    }
    const resolved = await which(configured, { env: environment });
    if (resolved) return resolved;
  }
  return resolveBundledClaudeExecutable() ?? which('claude', { env: environment });
}

export const claudeCodeAcpAgentDefinition: AcpAgentDefinition = {
  agentType: AgentType.CLAUDE_CODE,
  displayName: 'Claude Code',

  projectProvider: projectClaudeProvider,

  async resolveLaunch(input, profile) {
    let adapterPath: string;
    try {
      adapterPath = require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
    } catch (error) {
      throw new AgentRuntimeError(
        'missing_adapter',
        'dependency_check',
        'Claude Code ACP adapter was not found',
        false,
        { cause: error },
      );
    }
    const claudePath = await resolveClaudePath(profile.environment);
    if (!claudePath) {
      throw new AgentRuntimeError('missing_claude', 'dependency_check', 'Claude Code CLI was not found', true);
    }
    return {
      command: process.execPath,
      args: [adapterPath],
      cwd: input.workingDir,
      env: {
        ...profile.environment,
        CLAUDE_CODE_EXECUTABLE: claudePath,
        AGENT_TOWER_DEFER_CLAUDE_CONTEXT_USAGE: '1',
        ELECTRON_RUN_AS_NODE: '1',
      },
    };
  },

  async checkAvailability(provider) {
    try {
      require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
    } catch {
      return { type: 'NOT_FOUND', error: 'Claude Code ACP adapter is not installed' };
    }
    const profile = projectClaudeProvider(provider, { ...process.env } as Record<string, string>);
    return await resolveClaudePath(profile.environment)
      ? { type: 'INSTALLATION_FOUND' }
      : { type: 'NOT_FOUND', error: 'Claude Code CLI was not found' };
  },

  sessionMetadata(profile) {
    const settings = structuredClone(profile.settings ?? {});
    settings.permissions = { ...(settings.permissions as Record<string, unknown> ?? {}), defaultMode: profile.permissionMode === 'FULL_ACCESS' ? 'bypassPermissions' : 'default' };
    if (profile.model) settings.model = profile.model;
    if (profile.effort) settings.effortLevel = profile.effort;
    if (profile.permissionMode === 'FULL_ACCESS') {
      const configuredSandbox = settings.sandbox;
      settings.sandbox = {
        ...(configuredSandbox && typeof configuredSandbox === 'object' && !Array.isArray(configuredSandbox)
          ? configuredSandbox
          : {}),
        enabled: false,
      };
    }
    return { _meta: { claudeCode: { options: { settings } } } };
  },

  async configureSession(context, sessionId, response, profile) {
    let configOptions = response.configOptions ?? [];
    if (profile.model && configOptions.some(option => option.id === 'model')) {
      const updated = await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: profile.model,
      });
      configOptions = updated.configOptions;
    }
    if (profile.effort && configOptions.some(option => option.id === 'effort')) {
      await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'effort',
        value: profile.effort,
      });
    }
    const desiredMode = profile.permissionMode === 'FULL_ACCESS' ? 'bypassPermissions' : 'default';
    if (response.modes?.currentModeId === desiredMode) return;
    if (!response.modes?.availableModes.some(mode => mode.id === desiredMode)) {
        throw new AgentRuntimeError(
          'permission_mode_unsupported',
          'session',
          `Claude Code did not advertise '${desiredMode}'`,
          false,
        );
    }
    await context.request(acp.methods.agent.session.setMode, { sessionId, modeId: desiredMode });
  },
};
