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

  for (const [platform, spec] of Object.entries(item.install.platforms)) {
    if (!spec) continue;

    const downloadUrl = assertHttpsUrl(spec.downloadUrl, `${item.id}.install.platforms.${platform}.downloadUrl`);
    const allowedHosts = new Set(spec.allowedRedirectHosts.map((host) => host.toLowerCase()));
    if (!allowedHosts.has(downloadUrl.hostname.toLowerCase())) {
      throw new ValidationError(`Agent CLI manifest ${item.id} download host is not allowlisted`);
    }

    if (spec.allowedExactPaths.length === 0 && spec.allowedPathPrefixes.length === 0) {
      throw new ValidationError(`Agent CLI manifest ${item.id} must allow at least one path`);
    }

    if (!/^\.[A-Za-z0-9]{1,8}$/.test(spec.scriptExtension)) {
      throw new ValidationError(`Agent CLI manifest ${item.id} has invalid script extension`);
    }

    if (spec.maxBytes <= 0 || spec.maxBytes > 10 * 1024 * 1024) {
      throw new ValidationError(`Agent CLI manifest ${item.id} has invalid maxBytes`);
    }

    assertNoShellString(spec.interpreter.command, `${item.id}.install.platforms.${platform}.interpreter.command`);
    for (const [index, arg] of spec.interpreter.args.entries()) {
      assertNoShellString(arg, `${item.id}.install.platforms.${platform}.interpreter.args.${index}`);
    }

    for (const [index, arg] of spec.fixedArgs.entries()) {
      assertNoShellString(arg, `${item.id}.install.platforms.${platform}.fixedArgs.${index}`);
    }

    for (const [key, value] of Object.entries(spec.env ?? {})) {
      assertNoShellString(key, `${item.id}.install.platforms.${platform}.env.${key}.key`);
      assertNoShellString(value, `${item.id}.install.platforms.${platform}.env.${key}`);
    }

    assertNoShellString(spec.verifyCommand.command, `${item.id}.install.platforms.${platform}.verifyCommand.command`);
    for (const [index, arg] of spec.verifyCommand.args.entries()) {
      assertNoShellString(arg, `${item.id}.install.platforms.${platform}.verifyCommand.args.${index}`);
    }
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
