import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMcpConfigResponse } from './mcp-config.service.js'

describe('mcp-config service', () => {
  it('builds packaged desktop config from bundled runtime paths', () => {
    const config = buildMcpConfigResponse({
      serverDistDir: '/app/Resources/runtime/server/dist',
      env: {
        AGENT_TOWER_DESKTOP_RUNTIME_MODE: 'packaged',
        AGENT_TOWER_NODE_RUNTIME: 'C:\\Program Files\\Agent Tower\\resources\\runtime\\node\\node.exe',
        AGENT_TOWER_MCP_ENTRY: '/app/Resources/runtime/server/dist/mcp/index.js',
        AGENT_TOWER_DATA_DIR: '/Users/test/.agent-tower',
        AGENT_TOWER_URL: 'http://127.0.0.1:12580',
        AGENT_TOWER_PORT: '12580',
        AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      } as NodeJS.ProcessEnv,
    })

    expect(config.runtimeMode).toBe('desktop-packaged')
    expect(config.command).toBe('C:\\Program Files\\Agent Tower\\resources\\runtime\\node\\node.exe')
    expect(config.args).toEqual(['/app/Resources/runtime/server/dist/mcp/index.js'])
    expect(config.env).toEqual({
      AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      AGENT_TOWER_URL: 'http://127.0.0.1:12580',
      AGENT_TOWER_PORT: '12580',
    })
    expect(config.configJson).toContain('/app/Resources/runtime/server/dist/mcp/index.js')
    expect(config.configJson).not.toContain('agent-tower-mcp')
  })

  it('keeps Electron node-mode env only for packaged fallback config', () => {
    const config = buildMcpConfigResponse({
      serverDistDir: '/app/Resources/runtime/server/dist',
      env: {
        AGENT_TOWER_DESKTOP_RUNTIME_MODE: 'packaged',
        AGENT_TOWER_NODE_RUNTIME: '/app/Contents/MacOS/Agent Tower',
        AGENT_TOWER_MCP_ENTRY: '/app/Resources/runtime/server/dist/mcp/index.js',
        AGENT_TOWER_DATA_DIR: '/Users/test/.agent-tower',
        AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
        ELECTRON_RUN_AS_NODE: '1',
      } as NodeJS.ProcessEnv,
    })

    expect(config.command).toBe('/app/Contents/MacOS/Agent Tower')
    expect(config.env).toEqual({
      AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('builds workspace config without global agent-tower-mcp command', () => {
    const serverDistDir = path.resolve('/repo/packages/server/dist')
    const config = buildMcpConfigResponse({
      serverDistDir,
      env: {
        AGENT_TOWER_DATA_DIR: '/tmp/agent-tower-desktop-dev/data',
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
        AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      } as NodeJS.ProcessEnv,
    })

    expect(config.runtimeMode).toBe('workspace')
    expect(config.command).toBe(process.execPath)
    expect(config.args).toEqual([path.join(serverDistDir, 'mcp/index.js')])
    expect(config.env).toEqual({
      AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
    })
    expect(config.configJson).not.toContain('agent-tower-mcp')
  })

  it('fails clearly when internal token env is missing', () => {
    expect(() => buildMcpConfigResponse({
      serverDistDir: '/repo/packages/server/dist',
      env: {} as NodeJS.ProcessEnv,
    })).toThrow('AGENT_TOWER_INTERNAL_TOKEN is required')
  })
})
