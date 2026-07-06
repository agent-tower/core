export const PREVIEW_PREFIX = '/view';
export const PREVIEW_ACCESS_TOKEN_VERSION = 'pv1';
const PREVIEW_ACCESS_TOKEN_MARKER = '__agent_tower_preview';

export interface ParsedPreviewPath {
  workspaceId: string;
  previewToken: string | null;
  suffix: string;
  search: string;
}

export function buildPreviewPathPrefix(workspaceId: string, previewToken?: string | null): string {
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  if (!previewToken) return `${PREVIEW_PREFIX}/${encodedWorkspaceId}`;
  return `${PREVIEW_PREFIX}/${encodedWorkspaceId}/${PREVIEW_ACCESS_TOKEN_MARKER}/${encodeURIComponent(previewToken)}`;
}

function isPreviewAccessTokenSegment(segment: string): boolean {
  return segment.startsWith(`${PREVIEW_ACCESS_TOKEN_VERSION}.`);
}

export function parsePreviewPath(url: string): ParsedPreviewPath | null {
  const parsed = new URL(url, 'http://agent-tower.local');
  const prefix = `${PREVIEW_PREFIX}/`;
  if (!parsed.pathname.startsWith(prefix)) return null;

  const rest = parsed.pathname.slice(prefix.length);
  const slashIndex = rest.indexOf('/');
  const encodedWorkspaceId = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  if (!encodedWorkspaceId) return null;

  const workspaceId = decodeURIComponent(encodedWorkspaceId);
  let suffix = slashIndex === -1 ? '/' : rest.slice(slashIndex) || '/';
  let previewToken: string | null = null;

  if (suffix !== '/') {
    const suffixRest = suffix.slice(1);
    const markerSlashIndex = suffixRest.indexOf('/');
    const encodedFirstSegment = markerSlashIndex === -1 ? suffixRest : suffixRest.slice(0, markerSlashIndex);
    const firstSegment = decodeURIComponent(encodedFirstSegment);

    if (firstSegment === PREVIEW_ACCESS_TOKEN_MARKER && markerSlashIndex !== -1) {
      const afterMarker = suffixRest.slice(markerSlashIndex + 1);
      const tokenSlashIndex = afterMarker.indexOf('/');
      const encodedToken = tokenSlashIndex === -1 ? afterMarker : afterMarker.slice(0, tokenSlashIndex);
      const token = decodeURIComponent(encodedToken);
      if (isPreviewAccessTokenSegment(token)) {
        previewToken = token;
        suffix = tokenSlashIndex === -1 ? '/' : `/${afterMarker.slice(tokenSlashIndex + 1)}`;
        if (!suffix) suffix = '/';
      }
    }
  }

  return { workspaceId, previewToken, suffix, search: parsed.search };
}
