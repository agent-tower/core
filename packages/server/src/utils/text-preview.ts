export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const limit = Math.max(1, maxLength - 3);
  const sliced = value.slice(0, limit);
  const boundary = Math.max(
    sliced.lastIndexOf(' '),
    sliced.lastIndexOf('，'),
    sliced.lastIndexOf('。'),
    sliced.lastIndexOf(','),
    sliced.lastIndexOf('.')
  );
  const candidate = boundary >= Math.floor(limit * 0.6) ? sliced.slice(0, boundary) : sliced;
  return `${candidate.trimEnd()}...`;
}


export function buildTextPreview(value: string | null | undefined, maxLength = 240): string {
  const trimmed = (value ?? '').trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return truncateWithEllipsis(compactWhitespace(trimmed), maxLength);
}
