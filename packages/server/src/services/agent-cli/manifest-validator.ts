import type { AgentCliInstallManifestItem } from '@agent-tower/shared';
import { ValidationError } from '../../errors.js';

const SHELL_META_PATTERN = /(?:\||&&|\|\||;|`|\$\(|<\(|>\()/;

function assertNoShellString(value: string, field: string): void {
  if (SHELL_META_PATTERN.test(value)) {
    throw new ValidationError(`Agent CLI manifest contains shell metacharacters in ${field}`);
  }
}

function assertHttpsUrl(value: string, field: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new ValidationError(`Agent CLI manifest ${field} must use HTTPS`);
  }
  if (url.username || url.password) {
    throw new ValidationError(`Agent CLI manifest ${field} must not include userinfo`);
  }
  return url;
}

export function validateAgentCliManifestItem(item: AgentCliInstallManifestItem): void {
  if (item.install.kind === 'detect-only') return;

  const downloadUrl = assertHttpsUrl(item.install.downloadUrl, `${item.id}.install.downloadUrl`);
  const allowedHosts = new Set(item.install.allowedRedirectHosts.map((host) => host.toLowerCase()));
  if (!allowedHosts.has(downloadUrl.hostname.toLowerCase())) {
    throw new ValidationError(`Agent CLI manifest ${item.id} download host is not allowlisted`);
  }

  if (item.install.allowedExactPaths.length === 0 && item.install.allowedPathPrefixes.length === 0) {
    throw new ValidationError(`Agent CLI manifest ${item.id} must allow at least one path`);
  }

  if (item.install.maxBytes <= 0 || item.install.maxBytes > 10 * 1024 * 1024) {
    throw new ValidationError(`Agent CLI manifest ${item.id} has invalid maxBytes`);
  }

  for (const [platform, interpreter] of Object.entries(item.install.interpreters)) {
    assertNoShellString(interpreter.command, `${item.id}.install.interpreters.${platform}.command`);
    for (const [index, arg] of interpreter.args.entries()) {
      assertNoShellString(arg, `${item.id}.install.interpreters.${platform}.args.${index}`);
    }
  }

  for (const [index, arg] of item.install.fixedArgs.entries()) {
    assertNoShellString(arg, `${item.id}.install.fixedArgs.${index}`);
  }

  assertNoShellString(item.install.verifyCommand.command, `${item.id}.install.verifyCommand.command`);
  for (const [index, arg] of item.install.verifyCommand.args.entries()) {
    assertNoShellString(arg, `${item.id}.install.verifyCommand.args.${index}`);
  }
}

export function validateAgentCliManifest(items: readonly AgentCliInstallManifestItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new ValidationError(`Duplicate Agent CLI manifest id: ${item.id}`);
    }
    seen.add(item.id);
    validateAgentCliManifestItem(item);
  }
}
