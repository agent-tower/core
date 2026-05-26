const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

type RequestOptions = RequestInit & {
  params?: Record<string, string>
}

type ApiErrorPayload = Record<string, unknown>

class ApiClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  private async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { params, ...init } = options

    let url = `${this.baseUrl}${endpoint}`
    if (params) {
      const searchParams = new URLSearchParams(params)
      url += `?${searchParams.toString()}`
    }

    const headers: Record<string, string> = { ...init.headers as Record<string, string> }
    // 只有在有 body 时才设置 Content-Type
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    const response = await fetch(url, {
      ...init,
      headers,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as ApiErrorPayload
      throw new ApiError(
        response.status,
        typeof error.message === 'string'
          ? error.message
          : typeof error.error === 'string'
            ? error.error
            : 'Request failed',
        error,
      )
    }

    if (response.status === 204) {
      return undefined as T
    }

    return response.json()
  }

  get<T>(endpoint: string, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'GET' })
  }

  post<T>(endpoint: string, data?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  put<T>(endpoint: string, data?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  patch<T>(endpoint: string, data?: unknown, options?: RequestOptions) {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  delete<T>(endpoint: string, options?: RequestOptions) {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' })
  }
}

export class ApiError extends Error {
  status: number
  details: ApiErrorPayload

  constructor(status: number, message: string, details: ApiErrorPayload = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

export const apiClient = new ApiClient(API_BASE_URL)
