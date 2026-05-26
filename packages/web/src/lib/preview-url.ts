const API_BASE_URL = import.meta.env.VITE_API_URL

export function resolvePreviewViewUrl(viewUrl: string): string {
  if (!API_BASE_URL) return viewUrl

  try {
    const apiUrl = new URL(API_BASE_URL)
    return new URL(viewUrl, apiUrl.origin).toString()
  } catch {
    return viewUrl
  }
}
