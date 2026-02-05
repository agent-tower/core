import type { Socket } from 'socket.io'
import type { AckResponse } from '../events.js'

// 通用错误事件名
const ERROR_EVENT = 'error'

/**
 * 包装 handler 函数，统一处理错误
 */
export function withErrorHandler<T, R>(
  handler: (socket: Socket, payload: T) => Promise<R>
) {
  return async (
    socket: Socket,
    payload: T,
    callback?: (response: AckResponse<R>) => void
  ) => {
    try {
      const result = await handler(socket, payload)
      callback?.({ success: true, data: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[Socket Error] ${message}`, error)

      callback?.({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message,
        },
      })

      // 也发送错误事件给客户端
      socket.emit(ERROR_EVENT, {
        code: 'INTERNAL_ERROR',
        message,
      })
    }
  }
}

/**
 * 创建带验证的 handler
 */
export function createHandler<T, R>(
  validator: (payload: unknown) => T,
  handler: (socket: Socket, payload: T) => Promise<R>
) {
  return withErrorHandler(async (socket: Socket, payload: unknown) => {
    const validated = validator(payload)
    return handler(socket, validated)
  })
}
