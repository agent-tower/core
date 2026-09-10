import type * as acp from '@agentclientprotocol/sdk';
import type {
  AgentType,
  RuntimePermissionMode,
} from '@agent-tower/shared';
import type { AvailabilityInfo } from '../../../executors/base.executor.js';
import type { Provider } from '../../../executors/providers.js';
import type { RuntimeOpenInput } from '../../contracts.js';

export interface AcpAgentProfile {
  agentType: AgentType;
  environment: Record<string, string>;
  permissionMode: RuntimePermissionMode;
  authenticationRequest?: acp.AuthenticateRequest;
  appendPrompt?: string;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  /** Declares the selected model accepts image input (Pi `input: ["text","image"]`). */
  supportsImages?: boolean;
  settings?: Record<string, unknown>;
}

export interface AcpLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanup?: () => Promise<void>;
}

export type AcpStdoutFrameTransform = (
  frame: Record<string, unknown>,
) => Record<string, unknown>;

export type AcpSessionBootstrapResponse = Pick<acp.NewSessionResponse, 'modes' | 'configOptions'>;

export interface AcpAgentDefinition {
  readonly agentType: AgentType;
  readonly displayName: string;
  readonly initializeTimeoutMs?: number;
  readonly maxStdoutFrameBytes?: number;
  readonly transformStdoutFrame?: AcpStdoutFrameTransform;
  projectProvider(provider: Provider | null, inheritedEnvironment: Record<string, string>): AcpAgentProfile;
  resolveLaunch(input: RuntimeOpenInput, profile: AcpAgentProfile): Promise<AcpLaunchSpec>;
  checkAvailability(provider: Provider): Promise<AvailabilityInfo>;
  clientCapabilities?(profile: AcpAgentProfile): acp.ClientCapabilities;
  authenticate?(
    context: acp.ClientContext,
    response: acp.InitializeResponse,
    profile: AcpAgentProfile,
  ): Promise<void>;
  sessionMetadata?(profile: AcpAgentProfile): { _meta: Record<string, unknown> };
  configureSession?(
    context: acp.ClientContext,
    sessionId: string,
    response: AcpSessionBootstrapResponse,
    profile: AcpAgentProfile,
  ): Promise<void>;
}
