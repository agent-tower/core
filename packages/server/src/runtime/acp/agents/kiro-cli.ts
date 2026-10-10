import { AgentType } from '@agent-tower/shared';
import { createNativeAcpAgentDefinition } from './native-agent.js';

export const kiroCliAcpAgentDefinition = createNativeAcpAgentDefinition({
  agentType: AgentType.KIRO_CLI,
  displayName: 'Kiro CLI',
  supportsPermissionRestore: false,
  executableCandidates: ['kiro-cli'],
  executableEnvKeys: ['KIRO_CLI_PATH', 'KIRO_PATH'],
  arguments: (_input, profile) => [
    'acp',
    ...(profile.model ? ['--model', profile.model] : []),
    ...(profile.effort ? ['--effort', profile.effort] : []),
    ...(profile.permissionMode === 'FULL_ACCESS' ? ['--trust-all-tools'] : []),
  ],
  homeRelativeCandidates: [['.local', 'bin', 'kiro-cli'], ['.kiro', 'bin', 'kiro-cli']],
  permissionConfigKeys: ['trustAllTools'],
  configureSessionModel: false,
});
