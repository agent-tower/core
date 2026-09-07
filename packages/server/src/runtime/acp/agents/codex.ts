import { createRequire } from 'node:module';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { AgentType } from '@agent-tower/shared';
import { which } from '../../../utils/index.js';
import { AgentRuntimeError } from '../../errors.js';
import { projectCodexAcpProvider } from '../codex-provider-config.js';
import {
  codexAcpMaxStdoutFrameBytes,
  normalizeCodexAcpStdoutFrame,
} from './codex-frame-normalizer.js';
import { resolveBundledCodexEntrypoint } from './executable-resolution.js';
import type { AcpAgentDefinition } from './types.js';

const require = createRequire(import.meta.url);

export const codexAcpAgentDefinition: AcpAgentDefinition = {
  agentType: AgentType.CODEX,
  displayName: 'Codex',
  maxStdoutFrameBytes: codexAcpMaxStdoutFrameBytes,
  transformStdoutFrame: normalizeCodexAcpStdoutFrame,

  projectProvider(provider, inheritedEnvironment) {
    return {
      agentType: AgentType.CODEX,
      ...projectCodexAcpProvider(provider, inheritedEnvironment),
    };
  },

  clientCapabilities(profile) {
    if (profile.authenticationRequest?.methodId !== 'gateway') return {};
    return { auth: { _meta: { gateway: true } } };
  },

  async authenticate(context, response, profile) {
    const request = profile.authenticationRequest;
    if (!request) return;
    if (!response.authMethods?.some(method => method.id === request.methodId)) {
      throw new AgentRuntimeError(
        'authentication_method_unsupported',
        'authenticate',
        `Codex ACP adapter did not advertise the '${request.methodId}' authentication method`,
        false,
      );
    }
    await context.request(acp.methods.agent.authenticate, request);
  },

  async resolveLaunch(input, profile) {
    let adapterPath: string;
    try {
      adapterPath = require.resolve('@agentclientprotocol/codex-acp');
    } catch (error) {
      throw new AgentRuntimeError(
        'missing_adapter',
        'dependency_check',
        'Codex ACP adapter was not found',
        false,
        { cause: error },
      );
    }
    const codexPath = await resolveSystemCodex(profile.environment);
    if (!codexPath && !resolveBundledCodexEntrypoint()) {
      throw new AgentRuntimeError('missing_codex', 'dependency_check', 'Neither system nor bundled Codex Runtime was found', false);
    }
    const environment = { ...profile.environment };
    if (codexPath) environment.CODEX_PATH = codexPath;
    else delete environment.CODEX_PATH;

    return {
      command: process.execPath,
      args: [adapterPath],
      cwd: input.workingDir,
      env: {
        ...environment,
        ELECTRON_RUN_AS_NODE: '1',
        // Keep Agent Tower's session-scoped MCP when a global server uses the same name.
        DISABLE_MCP_CONFIG_FILTERING: 'true',
      },
    };
  },

  async checkAvailability(provider) {
    try {
      require.resolve('@agentclientprotocol/codex-acp');
    } catch {
      return { type: 'NOT_FOUND', error: 'Codex ACP adapter is not installed' };
    }
    const environment = { ...process.env, ...provider.env };
    const available = await resolveSystemCodex(environment) || resolveBundledCodexEntrypoint();
    return available
      ? { type: 'INSTALLATION_FOUND' }
      : { type: 'NOT_FOUND', error: 'Neither system nor bundled Codex Runtime was found' };
  },

  async configureSession(context, sessionId, response, profile) {
    if (profile.permissionMode === 'UNRESTRICTED' && response.modes?.currentModeId !== 'agent-full-access') {
      if (!response.modes?.availableModes.some(mode => mode.id === 'agent-full-access')) {
        throw new AgentRuntimeError(
          'permission_mode_unsupported',
          'session',
          'Codex did not advertise agent-full-access',
          false,
        );
      }
      await context.request(acp.methods.agent.session.setMode, {
        sessionId,
        modeId: 'agent-full-access',
      });
    }
    if (profile.fastMode === undefined) return;
    const option = response.configOptions?.find(candidate => candidate.id === 'fast-mode');
    if (!option) return;
    const value = option.type === 'boolean'
      ? profile.fastMode
      : profile.fastMode ? 'on' : 'off';
    if (option.currentValue === value) return;
    await context.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: option.id,
      value,
    });
  },
};

async function resolveSystemCodex(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const searchEnvironment = { ...environment };
  for (const key of Object.keys(searchEnvironment)) {
    if (key.toUpperCase() !== 'PATH') continue;
    searchEnvironment[key] = searchEnvironment[key]
      ?.split(path.delimiter)
      .filter(directory => path.isAbsolute(directory) && !/[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/i.test(directory))
      .join(path.delimiter);
  }
  return await which('codex', { env: searchEnvironment }) ?? undefined;
}
