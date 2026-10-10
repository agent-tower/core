import path from 'node:path';
import { AgentType } from '@agent-tower/shared';
import { createManagedDirectory } from './managed-directory.js';
import { MINION_ACP_SITECUSTOMIZE } from './minion-acp-sitecustomize.js';
import { createNativeAcpAgentDefinition } from './native-agent.js';

export const minionCodeAcpAgentDefinition = createNativeAcpAgentDefinition({
  agentType: AgentType.MINION_CODE,
  displayName: 'Minion Code',
  executableCandidates: ['mcode'],
  executableEnvKeys: ['MINION_CODE_PATH', 'MCODE_PATH'],
  arguments: (_input, profile) => [
    'acp',
    ...(profile.model ? ['--model', profile.model] : []),
    ...(profile.permissionMode === 'FULL_ACCESS' ? ['--dangerously-skip-permissions'] : []),
  ],
  homeRelativeCandidates: [['.local', 'bin', 'mcode']],
  permissionConfigKeys: ['dangerouslySkipPermissions'],
  configureSessionModel: false,
  buildEnvironment: profile => ({
    ...(profile.environment.OPENAI_API_KEY ? { DEFAULT_API_KEY: profile.environment.OPENAI_API_KEY } : {}),
    ...(profile.environment.OPENAI_BASE_URL ? { DEFAULT_BASE_URL: profile.environment.OPENAI_BASE_URL } : {}),
  }),
  async prepareLaunch(_input, profile) {
    const files: Record<string, string> = {
      'sitecustomize.py': MINION_ACP_SITECUSTOMIZE,
    };
    if (profile.model && profile.environment.OPENAI_API_KEY && profile.environment.OPENAI_BASE_URL) {
      const modelConfig = {
        api_type: 'openai',
        base_url: '${DEFAULT_BASE_URL}',
        api_key: '${DEFAULT_API_KEY}',
        model: profile.model,
        temperature: 0,
      };
      files['config/config.yaml'] = `${JSON.stringify({
        models: { [profile.model]: modelConfig },
        llm: modelConfig,
      }, null, 2)}\n`;
    }
    const managed = await createManagedDirectory('minion-acp', files);
    const inheritedPythonPath = profile.environment.PYTHONPATH;
    return {
      env: {
        MINION_ROOT: managed.path,
        PYTHONPATH: inheritedPythonPath
          ? `${managed.path}${path.delimiter}${inheritedPythonPath}`
          : managed.path,
      },
      cleanup: managed.cleanup,
    };
  },
});
