import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { normalizeRuntimePermissionMode, type AgentType } from '@agent-tower/shared';
import { which } from '../../../utils/index.js';
import { AgentRuntimeError } from '../../errors.js';
import type { RuntimeOpenInput } from '../../contracts.js';
import type { AcpAgentDefinition, AcpAgentProfile, AcpLaunchSpec } from './types.js';

type NativeArguments = (
  input: RuntimeOpenInput,
  profile: AcpAgentProfile,
  executablePath: string,
) => Promise<string[]> | string[];

interface NativeAgentOptions {
  agentType: AgentType;
  displayName: string;
  executableCandidates: string[];
  executableEnvKeys: string[];
  arguments: string[] | NativeArguments;
  homeRelativeCandidates?: string[][];
  initializeTimeoutMs?: number;
  /**
   * Raise when the adapter reports large tool results inline (for example
   * base64 image reads); the shared default rejects anything above 1 MiB.
   */
  maxStdoutFrameBytes?: number;
  permissionConfigKeys?: string[];
  configureSessionModel?: boolean;
  sessionModelValue?: (profile: AcpAgentProfile) => string | undefined;
  unrestrictedModeId?: string;
  buildEnvironment?: (profile: AcpAgentProfile) => Record<string, string>;
  prepareLaunch?: (
    input: RuntimeOpenInput,
    profile: AcpAgentProfile,
    executablePath: string,
  ) => Promise<Pick<AcpLaunchSpec, 'env' | 'cleanup'>>;
}

export function createNativeAcpAgentDefinition(options: NativeAgentOptions): AcpAgentDefinition {
  const projectProvider: AcpAgentDefinition['projectProvider'] = (provider, inheritedEnvironment) => {
    const environment = { ...inheritedEnvironment };
    const providerEnvironment = provider?.env ?? {};
    if ('OPENAI_API_KEY' in providerEnvironment || 'OPENAI_BASE_URL' in providerEnvironment) {
      delete environment.OPENAI_API_KEY;
      delete environment.OPENAI_BASE_URL;
    }
    Object.assign(environment, providerEnvironment);

    const model = readNonEmptyString(provider?.config.model);
    const effort = readNonEmptyString(provider?.config.effort);
    const appendPrompt = readNonEmptyString(provider?.config.appendPrompt);
    const configuredMode = provider?.config.permissionMode ?? provider?.config.acpPermissionMode;
    const permissionEnabled = options.permissionConfigKeys?.some(key => provider?.config[key] === true) ?? false;
    const permissionMode = configuredMode === undefined
      ? permissionEnabled ? 'UNRESTRICTED' : 'ASK'
      : normalizeRuntimePermissionMode(configuredMode);

    return {
      agentType: options.agentType,
      environment,
      permissionMode,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(appendPrompt ? { appendPrompt } : {}),
      settings: parseJsonSettings(provider?.settings, options.displayName),
    };
  };

  return {
    agentType: options.agentType,
    displayName: options.displayName,
    ...(options.initializeTimeoutMs ? { initializeTimeoutMs: options.initializeTimeoutMs } : {}),
    ...(options.maxStdoutFrameBytes ? { maxStdoutFrameBytes: options.maxStdoutFrameBytes } : {}),
    projectProvider,

    async resolveLaunch(input, profile) {
      const executablePath = await resolveNativeExecutable(profile.environment, options);
      if (!executablePath) {
        throw new AgentRuntimeError(
          'missing_agent',
          'dependency_check',
          `${options.displayName} CLI was not found`,
          true,
        );
      }
      const args = typeof options.arguments === 'function'
        ? await options.arguments(input, profile, executablePath)
        : [...options.arguments];
      const environment = { ...profile.environment, ...options.buildEnvironment?.(profile) };
      const prepared = await options.prepareLaunch?.(input, profile, executablePath);
      return {
        command: executablePath,
        args,
        cwd: input.workingDir,
        env: { ...environment, ...prepared?.env },
        ...(prepared?.cleanup ? { cleanup: prepared.cleanup } : {}),
      };
    },

    async checkAvailability(provider) {
      const profile = projectProvider(provider, { ...process.env } as Record<string, string>);
      return await resolveNativeExecutable(profile.environment, options)
        ? { type: 'INSTALLATION_FOUND' }
        : { type: 'NOT_FOUND', error: `${options.displayName} CLI was not found` };
    },

    async configureSession(context, sessionId, response, profile) {
      const sessionModel = options.sessionModelValue?.(profile) ?? profile.model;
      if (
        options.configureSessionModel !== false
        && sessionModel
        && response.configOptions?.some(option => option.id === 'model')
      ) {
        await context.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'model',
          value: sessionModel,
        });
      }
      if (
        profile.permissionMode === 'UNRESTRICTED'
        && options.unrestrictedModeId
        && response.modes?.currentModeId !== options.unrestrictedModeId
      ) {
        if (!response.modes?.availableModes.some(mode => mode.id === options.unrestrictedModeId)) {
          throw new AgentRuntimeError(
            'permission_mode_unsupported',
            'session',
            `${options.displayName} did not advertise its unrestricted mode`,
            false,
          );
        }
        await context.request(acp.methods.agent.session.setMode, {
          sessionId,
          modeId: options.unrestrictedModeId,
        });
      }
    },
  };
}

export async function geminiAcpArguments(
  _input: RuntimeOpenInput,
  profile: AcpAgentProfile,
  executablePath: string,
): Promise<string[]> {
  const help = await executableHelp(executablePath);
  const acpFlag = /(?:^|\s)--acp(?:\s|$)/m.test(help) ? '--acp' : '--experimental-acp';
  return [
    acpFlag,
    ...(profile.model ? ['--model', profile.model] : []),
    ...(profile.permissionMode === 'UNRESTRICTED' ? ['--no-sandbox', '--approval-mode', 'yolo'] : []),
  ];
}

async function resolveNativeExecutable(
  environment: NodeJS.ProcessEnv,
  options: Pick<NativeAgentOptions, 'executableCandidates' | 'executableEnvKeys' | 'homeRelativeCandidates'>,
): Promise<string | null> {
  for (const key of options.executableEnvKeys) {
    const configured = environment[key]?.trim();
    if (!configured) continue;
    if (path.isAbsolute(configured) && await isExecutable(configured)) return configured;
    const resolved = await which(configured, { env: environment });
    if (resolved) return resolved;
  }
  for (const command of options.executableCandidates) {
    const executable = process.platform === 'win32' && !path.extname(command) ? `${command}.cmd` : command;
    const resolved = await which(executable, { env: environment });
    if (resolved) return resolved;
  }
  const home = environment.HOME;
  if (home) {
    for (const segments of options.homeRelativeCandidates ?? []) {
      const candidate = path.join(home, ...segments);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

const helpCache = new Map<string, Promise<string>>();

function executableHelp(executablePath: string): Promise<string> {
  const cached = helpCache.get(executablePath);
  if (cached) return cached;
  const pending = new Promise<string>((resolve) => {
    execFile(executablePath, ['--help'], { timeout: 5_000, maxBuffer: 1_048_576 }, (_error, stdout, stderr) => {
      resolve(`${stdout}${stderr}`);
    });
  });
  helpCache.set(executablePath, pending);
  return pending;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseJsonSettings(settings: string | undefined, displayName: string): Record<string, unknown> {
  if (!settings?.trim()) return {};
  try {
    const parsed = JSON.parse(settings) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new AgentRuntimeError(
      'provider_config_invalid',
      'provider_config',
      `${displayName} Provider settings must be a JSON object`,
      false,
      { cause: error },
    );
  }
}
