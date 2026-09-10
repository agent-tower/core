import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { AgentType, normalizeRuntimePermissionMode, type McpConfigResponse } from '@agent-tower/shared';
import { which } from '../../../utils/index.js';
import { buildMcpConfigResponse } from '../../../services/mcp-config.service.js';
import { AgentRuntimeError } from '../../errors.js';
import { isExecutableFile, resolveBundledPiExecutable } from './executable-resolution.js';
import { createManagedDirectory } from './managed-directory.js';
import type { AcpAgentDefinition, AcpAgentProfile } from './types.js';

const require = createRequire(import.meta.url);

export const piCodingAgentAcpAgentDefinition: AcpAgentDefinition = {
  agentType: AgentType.PI_CODING_AGENT,
  displayName: 'Pi Coding Agent',

  projectProvider(provider, inheritedEnvironment) {
    const environment = { ...inheritedEnvironment };
    if ('OPENAI_API_KEY' in (provider?.env ?? {}) || 'OPENAI_BASE_URL' in (provider?.env ?? {})) {
      delete environment.OPENAI_API_KEY;
      delete environment.OPENAI_BASE_URL;
    }
    Object.assign(environment, provider?.env ?? {});
    const model = readNonEmptyString(provider?.config.model);
    const effort = readNonEmptyString(provider?.config.effort);
    const appendPrompt = readNonEmptyString(provider?.config.appendPrompt);
    const configuredMode = provider?.config.permissionMode ?? provider?.config.acpPermissionMode;
    const permissionMode = configuredMode === undefined
      ? provider?.config.autoApprove === true ? 'UNRESTRICTED' : 'ASK'
      : normalizeRuntimePermissionMode(configuredMode);
    const supportsImages = provider?.config.supportsImages === true;
    return {
      agentType: AgentType.PI_CODING_AGENT,
      environment,
      permissionMode,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(appendPrompt ? { appendPrompt } : {}),
      ...(supportsImages ? { supportsImages } : {}),
      settings: parseSettings(provider?.settings),
    };
  },

  async resolveLaunch(input, profile) {
    assertSupportedNodeVersion();
    const piPath = await resolvePiPath(profile.environment);
    if (!piPath) {
      throw new AgentRuntimeError('missing_agent', 'dependency_check', 'Pi Coding Agent CLI was not found', true);
    }

    let adapterPath: string;
    let mcpAdapterRoot: string;
    try {
      adapterPath = require.resolve('pi-acp');
      mcpAdapterRoot = resolvePiMcpAdapterRoot();
    } catch (error) {
      throw new AgentRuntimeError(
        'missing_adapter',
        'dependency_check',
        'Pi ACP or MCP adapter was not found',
        false,
        { cause: error },
      );
    }

    const mcpConfig = buildMcpConfigResponse({ env: profile.environment });
    const managed = await createManagedDirectory('pi-acp', buildPiConfigFiles(profile, mcpAdapterRoot, mcpConfig.config));
    return {
      command: process.execPath,
      args: [adapterPath],
      cwd: input.workingDir,
      env: {
        ...profile.environment,
        PI_ACP_PI_COMMAND: piPath,
        PI_CODING_AGENT_DIR: managed.path,
        ELECTRON_RUN_AS_NODE: '1',
      },
      cleanup: managed.cleanup,
    };
  },

  async checkAvailability(provider) {
    try {
      assertSupportedNodeVersion();
      require.resolve('pi-acp');
      require.resolve('pi-mcp-adapter');
    } catch (error) {
      return { type: 'NOT_FOUND', error: error instanceof Error ? error.message : 'Pi ACP dependencies are unavailable' };
    }
    const profile = this.projectProvider(provider, { ...process.env } as Record<string, string>);
    return await resolvePiPath(profile.environment)
      ? { type: 'INSTALLATION_FOUND' }
      : { type: 'NOT_FOUND', error: 'Pi Coding Agent CLI was not found' };
  },

  async configureSession(context, sessionId, response, profile) {
    let configOptions = response.configOptions ?? [];
    if (profile.model && configOptions.some(option => option.id === 'model')) {
      const updated = await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: `agent-tower/${profile.model}`,
      });
      configOptions = updated.configOptions;
    }
    if (profile.effort && configOptions.some(option => option.id === 'thought_level')) {
      await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'thought_level',
        value: profile.effort,
      });
    }
  },
};

function buildPiConfigFiles(
  profile: AcpAgentProfile,
  mcpAdapterRoot: string,
  mcpConfig: McpConfigResponse['config'],
): Record<string, string> {
  const settings = structuredClone(profile.settings ?? {});
  const configuredPackages = Array.isArray(settings.packages) ? settings.packages : [];
  settings.packages = [
    ...configuredPackages.filter(value => value !== mcpAdapterRoot),
    mcpAdapterRoot,
  ];
  settings.quietStartup ??= true;
  if (profile.effort) settings.defaultThinkingLevel = profile.effort;

  const files: Record<string, string> = {
    'mcp.json': formattedJson({
      ...mcpConfig,
      // Team Room prompts use original MCP names; Pi prefixes them with the server name by default.
      settings: { toolPrefix: 'none' },
    }),
  };
  const model = profile.model ?? profile.environment.OPENAI_MODEL;
  const baseUrl = profile.environment.OPENAI_BASE_URL
    ?? (profile.environment.OPENAI_API_KEY ? 'https://api.openai.com/v1' : undefined);
  if (model && baseUrl) {
    settings.defaultProvider ??= 'agent-tower';
    settings.defaultModel ??= model;
    files['models.json'] = formattedJson({
      providers: {
        'agent-tower': {
          baseUrl,
          api: profile.environment.OPENAI_WIRE_API === 'responses'
            ? 'openai-responses'
            : 'openai-completions',
          apiKey: profile.environment.OPENAI_API_KEY ? '$OPENAI_API_KEY' : 'agent-tower',
          models: [{
            id: model,
            name: model,
            reasoning: true,
            // Pi gates image attachments on `model.input.includes('image')`; without
            // this declaration the read tool replaces images with a "model does not
            // support images" note even when the backend is vision-capable.
            ...(profile.supportsImages ? { input: ['text', 'image'] } : {}),
          }],
        },
      },
    });
  }
  files['settings.json'] = formattedJson(settings);
  return files;
}

/**
 * Resolves the installed `pi-mcp-adapter` package root.
 *
 * Recent versions restrict their `exports` map and no longer expose
 * `pi-mcp-adapter/package.json`, so resolve the package entry instead and walk
 * up to the directory that owns the manifest.
 */
function resolvePiMcpAdapterRoot(): string {
  const entry = require.resolve('pi-mcp-adapter');
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(entry);
}

async function resolvePiPath(environment: NodeJS.ProcessEnv): Promise<string | null> {
  for (const key of ['PI_CODING_AGENT_PATH', 'PI_PATH']) {
    const configured = environment[key]?.trim();
    if (!configured) continue;
    if (path.isAbsolute(configured)) {
      if (await isExecutableFile(configured)) return configured;
      continue;
    }
    const resolved = await which(configured, { env: environment });
    if (resolved) return resolved;
  }
  return resolveBundledPiExecutable() ?? null;
}

function assertSupportedNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new AgentRuntimeError(
      'unsupported_node',
      'dependency_check',
      'Bundled Pi requires Node.js 22.19.0 or newer',
      false,
    );
  }
}

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
      'Pi Coding Agent Provider settings must be a JSON object',
      false,
      { cause: error },
    );
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formattedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
