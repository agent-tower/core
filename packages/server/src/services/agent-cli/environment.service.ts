import type {
  AgentCliCreateInstallTaskResponse,
  AgentCliEnvironmentStatus,
  AgentCliInstallLogResponse,
  AgentCliInstallManifestItem,
  AgentCliInstallPreview,
  AgentCliInstallTask,
  AgentCliPublicInstallManifestItem,
  AgentCliToolId,
} from '@agent-tower/shared';
import { NotFoundError, ServiceError, ValidationError } from '../../errors.js';
import { AgentCliDetector } from './detection.js';
import type { AgentCliExecFile } from './command-runner.js';
import {
  AgentCliDownloader,
  type AgentCliDownloadOptions,
  type AgentCliStoredPreview,
  removePreviewFile,
  toPublicPreview,
} from './downloader.js';
import {
  getAgentCliManifest,
  getAgentCliManifestItem,
  getServerAgentCliPlatform,
} from './manifest.js';
import { AgentCliInstallTaskManager, type AgentCliRunner } from './task-manager.js';

export interface AgentCliEnvironmentServiceOptions {
  downloader?: AgentCliDownloader
  downloaderOptions?: AgentCliDownloadOptions
  detector?: AgentCliDetector
  execFileImpl?: AgentCliExecFile
  taskManager?: AgentCliInstallTaskManager
  runner?: AgentCliRunner
  platform?: NodeJS.Platform
  now?: () => Date
}

function cloneCommandSpec<T extends { command: string; args: string[]; timeoutMs: number; versionPattern?: string }>(
  spec: T
): T {
  return {
    ...spec,
    args: [...spec.args],
  };
}

function toPublicManifestItem(item: AgentCliInstallManifestItem): AgentCliPublicInstallManifestItem {
  const base = {
    ...item,
    officialSources: item.officialSources.map((source) => ({ ...source })),
    supportedPlatforms: [...item.supportedPlatforms],
    detectionCommands: item.detectionCommands.map(cloneCommandSpec),
    versionCommand: item.versionCommand ? cloneCommandSpec(item.versionCommand) : undefined,
    authCommand: item.authCommand ? cloneCommandSpec(item.authCommand) : undefined,
  };

  if (item.install.kind === 'detect-only') {
    return {
      ...base,
      install: { ...item.install },
    };
  }

  const install = item.install;

  return {
    ...base,
    install: {
      kind: install.kind,
      platforms: Object.fromEntries(
        Object.entries(install.platforms).map(([platform, spec]) => {
          if (!spec) return [platform, spec];
          const { verifyCommand: _verifyCommand, ...publicSpec } = spec;
          return [
            platform,
            {
              ...publicSpec,
              allowedRedirectHosts: [...spec.allowedRedirectHosts],
              allowedExactPaths: [...spec.allowedExactPaths],
              allowedPathPrefixes: [...spec.allowedPathPrefixes],
              interpreter: { command: spec.interpreter.command, args: [...spec.interpreter.args] },
              fixedArgs: [...spec.fixedArgs],
              env: spec.env ? { ...spec.env } : undefined,
              riskNotes: [...spec.riskNotes],
            },
          ];
        })
      ),
    },
  };
}

export class AgentCliEnvironmentService {
  private readonly manifest: AgentCliInstallManifestItem[];
  private readonly downloader: AgentCliDownloader;
  private readonly detector: AgentCliDetector;
  private readonly taskManager: AgentCliInstallTaskManager;
  private readonly previews = new Map<string, AgentCliStoredPreview>();
  private readonly platform;
  private readonly now;

  constructor(options: AgentCliEnvironmentServiceOptions = {}) {
    this.platform = getServerAgentCliPlatform(options.platform ?? process.platform);
    this.now = options.now ?? (() => new Date());
    this.manifest = getAgentCliManifest();
    this.downloader = options.downloader ?? new AgentCliDownloader(options.downloaderOptions);
    this.detector = options.detector ?? new AgentCliDetector(options.execFileImpl, this.platform);
    this.taskManager = options.taskManager ?? new AgentCliInstallTaskManager(options.runner);
  }

  getManifest(): AgentCliPublicInstallManifestItem[] {
    return this.manifest.map(toPublicManifestItem);
  }

  getStatus(): AgentCliEnvironmentStatus {
    return this.detector.getCachedStatus(this.manifest);
  }

  refreshStatus(): Promise<AgentCliEnvironmentStatus> {
    return this.detector.refresh(this.manifest);
  }

  async createPreview(toolId: AgentCliToolId): Promise<AgentCliInstallPreview> {
    await this.cleanupExpiredPreviews();
    const item = getAgentCliManifestItem(toolId);
    if (!item) throw new NotFoundError('Agent CLI manifest item', toolId);
    if (!this.platform || !item.supportedPlatforms.includes(this.platform)) {
      throw new ServiceError('Agent CLI installer unsupported on this platform', 'AGENT_CLI_UNSUPPORTED_PLATFORM', 400);
    }
    if (item.install.kind !== 'downloaded-script') {
      throw new ServiceError('Agent CLI tool is detect-only', 'AGENT_CLI_INSTALL_UNAVAILABLE', 400);
    }
    const install = item.install.platforms[this.platform];
    if (!install) {
      throw new ServiceError('Agent CLI installer unsupported on this platform', 'AGENT_CLI_UNSUPPORTED_PLATFORM', 400);
    }

    const preview = await this.downloader.createPreview(item.id, this.platform, install);
    this.previews.set(preview.id, preview);
    return toPublicPreview(preview);
  }

  async getPreview(previewId: string): Promise<AgentCliInstallPreview> {
    await this.cleanupExpiredPreviews();
    const preview = this.previews.get(previewId);
    if (!preview) throw new NotFoundError('Agent CLI install preview', previewId);
    return toPublicPreview(preview);
  }

  async createTask(previewId: string): Promise<AgentCliCreateInstallTaskResponse> {
    await this.cleanupExpiredPreviews();
    const preview = this.previews.get(previewId);
    if (!preview) {
      throw new ServiceError('Agent CLI install preview expired or not found', 'AGENT_CLI_PREVIEW_EXPIRED', 409);
    }
    if (preview.status !== 'ready') {
      throw new ValidationError('Agent CLI install preview is not ready');
    }

    preview.status = 'consumed';
    const result = this.taskManager.createTask(preview);
    this.previews.delete(previewId);
    return result;
  }

  getTask(taskId: string): AgentCliInstallTask {
    return this.taskManager.getTask(taskId);
  }

  getLogs(taskId: string, afterSeq = 0): AgentCliInstallLogResponse {
    return this.taskManager.getLogs(taskId, afterSeq);
  }

  cancelTask(taskId: string): AgentCliInstallTask {
    return this.taskManager.cancel(taskId);
  }

  async cleanupExpiredPreviews(): Promise<void> {
    const nowMs = this.now().getTime();
    const removals: Promise<void>[] = [];
    for (const [previewId, preview] of this.previews) {
      if (preview.status !== 'ready' || new Date(preview.expiresAt).getTime() <= nowMs) {
        preview.status = 'expired';
        this.previews.delete(previewId);
        removals.push(removePreviewFile(preview.tempFilePath));
      }
    }
    await Promise.all(removals);
  }
}
