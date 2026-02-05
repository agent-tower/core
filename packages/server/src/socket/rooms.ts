/**
 * 房间名称生成工具
 * 统一管理房间命名规则
 */

export const getRoomName = {
  /**
   * 看板房间
   * 用于看板内的实时协作
   */
  board: (boardId: string) => `board:${boardId}`,

  /**
   * 用户私人房间
   * 用于接收个人通知
   */
  user: (userId: string) => `user:${userId}`,

  /**
   * 项目房间（可选）
   * 用于项目级别的广播
   */
  project: (projectId: string) => `project:${projectId}`,
}

/**
 * 从房间名称解析 ID
 */
export const parseRoomName = {
  board: (roomName: string): string | null => {
    const match = roomName.match(/^board:(.+)$/)
    return match ? match[1] : null
  },

  user: (roomName: string): string | null => {
    const match = roomName.match(/^user:(.+)$/)
    return match ? match[1] : null
  },

  project: (roomName: string): string | null => {
    const match = roomName.match(/^project:(.+)$/)
    return match ? match[1] : null
  },
}
