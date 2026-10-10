import { AgentType } from '@agent-tower/shared';
import { createNativeAcpAgentDefinition } from './native-agent.js';

export const openCodeAcpAgentDefinition = createNativeAcpAgentDefinition({
  agentType: AgentType.OPENCODE,
  displayName: 'OpenCode',
  executableCandidates: ['opencode'],
  executableEnvKeys: ['OPENCODE_PATH'],
  arguments: ['acp'],
  homeRelativeCandidates: [['.opencode', 'bin', 'opencode']],
  initializeTimeoutMs: 60_000,
  permissionConfigKeys: ['autoApprove'],
  sessionModelValue: profile => profile.model ? `agent-tower/${profile.model}` : undefined,
  buildEnvironment(profile): Record<string, string> {
    const apiKey = profile.environment.OPENAI_API_KEY;
    const model = profile.model;
    const raw = profile.environment.OPENCODE_CONFIG_CONTENT;
    const inherited = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    // OPENCODE_PERMISSION is applied after config files by upstream. Project it as well.
    const envPermission = profile.environment.OPENCODE_PERMISSION
      ? JSON.parse(profile.environment.OPENCODE_PERMISSION) as unknown : undefined;
    const baseline = profile.permissionMode === 'FULL_ACCESS' ? 'allow' : 'ask';
    const permission = projectPermission([inherited.permission, envPermission], baseline);
    const projectAgents = (value: unknown) => !value || typeof value !== 'object' || Array.isArray(value)
      ? value : Object.fromEntries(Object.entries(value).map(([name, options]) => [name,
        options && typeof options === 'object' && !Array.isArray(options)
          ? { ...options, permission: projectPermission([inherited.permission, envPermission, (options as Record<string, unknown>).permission], baseline) }
          : options,
      ]));
    const config = { ...inherited, permission,
      ...(inherited.agent ? { agent: projectAgents(inherited.agent) } : {}),
      ...(inherited.mode ? { mode: projectAgents(inherited.mode) } : {}),
    };
    const permissionEnvironment = { OPENCODE_PERMISSION: JSON.stringify(permission) };
    if (!apiKey || !model || raw) return { ...permissionEnvironment, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    const baseUrl = profile.environment.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const usesChatCompletions = profile.environment.OPENAI_WIRE_API === 'chat_completions';
    return {
      ...permissionEnvironment,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission,
        model: `agent-tower/${model}`,
        provider: {
          'agent-tower': {
            npm: usesChatCompletions ? '@ai-sdk/openai-compatible' : '@ai-sdk/openai',
            name: 'Agent Tower OpenAI',
            options: { apiKey, baseURL: baseUrl },
            models: { [model]: { name: model } },
          },
        },
      }),
    };
  },
});

/** Retain explicit native deny rules from every source; all other rules use the selected mode. */
function projectPermission(values: unknown[], baseline: 'ask' | 'allow'): Record<string, unknown> {
  const denies: Record<string, unknown> = {};
  const merge = (target: Record<string, unknown>, value: unknown): void => {
    if (value === 'deny') { target['*'] = 'deny'; return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, rule] of Object.entries(value)) {
      if (rule === 'deny') target[key] = 'deny';
      else if (rule && typeof rule === 'object' && !Array.isArray(rule) && target[key] !== 'deny') {
        const nested = (target[key] as Record<string, unknown> | undefined) ?? {};
        merge(nested, rule);
        if (Object.keys(nested).length) target[key] = nested;
      }
    }
  };
  for (const value of values) merge(denies, value);
  const fill = (value: Record<string, unknown>): Record<string, unknown> => value['*'] === 'deny' ? { '*': 'deny' } : ({ '*': baseline,
    ...Object.fromEntries(Object.entries(value).map(([key, rule]) => [key, rule === 'deny' ? rule : fill(rule as Record<string, unknown>)])),
  });
  return fill(denies);
}
