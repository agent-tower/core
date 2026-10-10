import { AgentType } from '@agent-tower/shared';
import { createNativeAcpAgentDefinition } from './native-agent.js';

export const grokBuildAcpAgentDefinition = createNativeAcpAgentDefinition({
  agentType: AgentType.GROK_BUILD,
  displayName: 'Grok Build',
  supportsPermissionRestore: false,
  executableCandidates: ['grok'],
  executableEnvKeys: ['GROK_PATH'],
  arguments: (_input, profile) => [
    '--permission-mode', profile.permissionMode === 'FULL_ACCESS' ? 'bypassPermissions' : 'default',
    ...(profile.permissionMode === 'FULL_ACCESS' ? ['--sandbox', 'off'] : []),
    'agent',
    ...(profile.model ? ['--model', profile.model] : []),
    ...(profile.permissionMode === 'FULL_ACCESS' ? ['--always-approve'] : []),
    ...(profile.environment.OPENAI_BASE_URL
      ? ['--xai-api-base-url', profile.environment.OPENAI_BASE_URL]
      : []),
    'stdio',
  ],
  homeRelativeCandidates: [['.grok', 'bin', 'grok']],
  permissionConfigKeys: ['alwaysApprove'],
  configureSessionModel: false,
  buildEnvironment(profile): Record<string, string> {
    return profile.environment.OPENAI_API_KEY && !profile.environment.XAI_API_KEY
      ? { XAI_API_KEY: profile.environment.OPENAI_API_KEY }
      : {};
  },
});
