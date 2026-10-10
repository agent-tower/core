import { AgentType } from '@agent-tower/shared';
import { createNativeAcpAgentDefinition, geminiAcpArguments } from './native-agent.js';

export const geminiCliAcpAgentDefinition = createNativeAcpAgentDefinition({
  agentType: AgentType.GEMINI_CLI,
  displayName: 'Gemini CLI',
  executableCandidates: ['gemini'],
  executableEnvKeys: ['GEMINI_PATH', 'GEMINI_CLI_PATH'],
  arguments: geminiAcpArguments,
  permissionConfigKeys: ['yolo'],
  configureSessionModel: false,
  unrestrictedModeId: 'yolo',
  askModeId: 'default',
});
