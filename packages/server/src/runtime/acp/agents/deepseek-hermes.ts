import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { AgentType } from '@agent-tower/shared';
import { resolveDataDir } from '../../../utils/data-dir.js';
import { createNativeAcpAgentDefinition } from './native-agent.js';
import type { AcpAgentProfile, AcpAgentDefinition } from './types.js';

/** Route name `dsh-llm-deepseek` registers for DeepSeek's official API. */
const DEFAULT_PROVIDER_ROUTE = 'deepseek-official';

/**
 * `dsh` accepts the ACP protocol version verbatim and its shipped `acp` profile
 * may bootstrap a pnpm workspace on first launch, so allow a generous window.
 */
const INITIALIZE_TIMEOUT_MS = 180_000;

/**
 * `dsh` exposes the model selector as an opaque *string* that carries a JSON
 * tuple of `[providerRoute, modelId]` — verified against `@deepseek-ai/dsh`
 * 0.1.5-rc.1, which rejects both a bare model id and a raw JSON array.
 */
function encodeModelSelection(model: string, providerRoute: string): string {
  return JSON.stringify([providerRoute, model]);
}

function resolveProviderRoute(environment: Record<string, string>): string {
  return environment.DSH_PROVIDER_ROUTE?.trim() || DEFAULT_PROVIDER_ROUTE;
}

/**
 * Map Tower's ACP permission modes onto the harness permission presets defined
 * by `dsh-base`, which bind the sandbox scope and the approval policy together:
 *
 *   workspace-write    → sandbox confined to the workspace, every tool call asks
 *   danger-full-access → unrestricted sandbox, approvals never prompt
 *
 * `DSH_PERMISSION_MODE` drives both rows, so one variable covers the whole
 * preset. Anything other than an explicit `UNRESTRICTED` stays confined.
 */
function resolvePermissionMode(mode: AcpAgentProfile['permissionMode']): string {
  return mode === 'UNRESTRICTED' ? 'danger-full-access' : 'workspace-write';
}

/**
 * Persistent, per-Provider harness home.
 *
 * `dsh` resolves its data root as `$DSH_HOME` else `~/.dsh`; pointing it at a
 * Tower-owned directory keeps the Provider authoritative for credentials while
 * preserving sessions, storages and the bootstrapped profile across launches.
 * This directory is intentionally *not* cleaned up: it is the harness's durable
 * state, not a per-launch scratch directory.
 */
function resolveHarnessHome(providerId: string | null | undefined): string {
  return path.join(resolveDataDir(), 'deepseek-harness', sanitizeProviderId(providerId));
}

function sanitizeProviderId(providerId: string | null | undefined): string {
  const trimmed = providerId?.trim();
  if (!trimmed) return 'default';
  return trimmed.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'default';
}

/**
 * Pre-seed the `acp` profile so the first session does not pay for a profile
 * bootstrap.
 *
 * The contents mirror what `dsh`'s own `initProfile` writes, because that
 * scaffolder only fills in *missing* files — a half-written profile would make
 * it skip the rest. Every write is create-only, so a profile the user has
 * already customised is never overwritten.
 */
async function ensureHarnessHome(harnessHome: string): Promise<void> {
  const profileDir = path.join(harnessHome, 'profiles', 'acp');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(harnessHome, 0o700).catch(() => undefined);
  await writeIfAbsent(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-profile-acp',
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
          patchReload: 'startup',
        },
      },
    }, null, 2)}\n`,
  );
  await writeIfAbsent(
    path.join(profileDir, 'cordis.patch.yml'),
    '# Your patch layer for this dsh profile, applied after every bundle layer:\n'
      + '# a top-level YAML array of loader patch entries (id-targeted config\n'
      + '# overrides, disables, and insert lists; `!!js` expressions allowed).\n'
      + '[]\n',
  );
  await writeIfAbsent(
    path.join(profileDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  );
  await writeIfAbsent(path.join(profileDir, 'cordis.yml'), '# dsh profile root.\n[]\n');
}

async function writeIfAbsent(target: string, contents: string): Promise<void> {
  try {
    await writeFile(target, contents, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    // EEXIST means a previous launch (or the user) already owns this file.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    // A pre-seed failure must never block a launch: `dsh` self-bootstraps.
    console.warn(`[DeepSeek Harness] Could not pre-seed ${target}`, error);
  }
}

const nativeAgent = createNativeAcpAgentDefinition({
  agentType: AgentType.DEEPSEEK_HERMES,
  displayName: 'DeepSeek Harness',
  executableCandidates: ['dsh'],
  executableEnvKeys: ['DSH_PATH'],
  // `dsh --profile acp` is the published automation entry point.
  arguments: ['--profile', 'acp'],
  initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
  // `dsh` exposes no permission-bypass flag and no ACP mode selector; the
  // sandbox scope and approval policy are selected together through the
  // `DSH_PERMISSION_MODE` launch variable instead.
  permissionConfigKeys: [],
  sessionModelValue: profile => profile.model
    ? encodeModelSelection(profile.model, resolveProviderRoute(profile.environment))
    : undefined,
  buildEnvironment(profile): Record<string, string> {
    const environment: Record<string, string> = {};
    const apiKey = profile.environment.DEEPSEEK_API_KEY;
    if (apiKey) environment.DEEPSEEK_API_KEY = apiKey;
    const baseUrl = profile.environment.DEEPSEEK_BASE_URL;
    if (baseUrl) environment.DEEPSEEK_BASE_URL = baseUrl;
    environment.DSH_PERMISSION_MODE = resolvePermissionMode(profile.permissionMode);
    return environment;
  },
  async prepareLaunch(input, profile) {
    const harnessHome = resolveHarnessHome(input.providerId ?? null);
    await ensureHarnessHome(harnessHome);
    return { env: { DSH_HOME: harnessHome } };
  },
});

export const deepseekHermesAcpAgentDefinition: AcpAgentDefinition = {
  ...nativeAgent,

  async configureSession(context, sessionId, response, profile) {
    await nativeAgent.configureSession?.(context, sessionId, response, profile);
    await applyReasoningEffort(context, sessionId, response, profile);
  },
};

/**
 * The harness advertises `reasoning_effort` with its own `off|low|high|max`
 * scale, which must be selected separately from the model.
 */
async function applyReasoningEffort(
  context: acp.ClientContext,
  sessionId: string,
  response: { configOptions?: acp.SessionConfigOption[] | null },
  profile: AcpAgentProfile,
): Promise<void> {
  if (!profile.effort) return;
  if (!response.configOptions?.some(option => option.id === 'reasoning_effort')) return;
  await context.request(acp.methods.agent.session.setConfigOption, {
    sessionId,
    configId: 'reasoning_effort',
    value: profile.effort,
  });
}
