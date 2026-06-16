import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMcpConfigResponse } from './mcp-config.service.js'

describe('mcp-config service', () => {
  it('builds packaged desktop config from bundled runtime paths', () => {
    const config = buildMcpConfigResponse({
      serverDistDir: '/app/Resources/runtime/server/dist',
      env: {
        AGENT_TOWER_DESKTOP_RUNTIME_MODE: 'packaged',
        AGENT_TOWER_NODE_RUNTIME: '/app/Contents/MacOS/Agent Tower Desktop Spike',
        AGENT_TOWER_MCP_ENTRY: '/app/Resources/runtime/server/dist/mcp/index.js',
        AGENT_TOWER_DATA_DIR: '/Users/test/.agent-tower',
      } as NodeJS.ProcessEnv,
    })

    expect(config.runtimeMode).toBe('desktop-packaged')
    expect(config.command).toBe('/app/Contents/MacOS/Agent Tower Desktop Spike')
    expect(config.args).toEqual(['/app/Resources/runtime/server/dist/mcp/index.js'])
    expect(config.env).toEqual({
      AGENT_TOWER_DATA_DIR: '/Users/test/.agent-tower',
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(config.configJson).toContain('/app/Resources/runtime/server/dist/mcp/index.js')
    expect(config.configJson).not.toContain('agent-tower-mcp')
  })

  it('builds workspace config without global agent-tower-mcp command', () => {
    const serverDistDir = path.resolve('/repo/packages/server/dist')
    const config = buildMcpConfigResponse({
      serverDistDir,
      env: {
        AGENT_TOWER_DATA_DIR: '/tmp/agent-tower-desktop-dev/data',
      } as NodeJS.ProcessEnv,
    })

    expect(config.runtimeMode).toBe('workspace')
    expect(config.command).toBe(process.execPath)
    expect(config.args).toEqual([path.join(serverDistDir, 'mcp/index.js')])
    expect(config.env).toEqual({
      AGENT_TOWER_DATA_DIR: '/tmp/agent-tower-desktop-dev/data',
    })
    expect(config.configJson).not.toContain('agent-tower-mcp')
  })
})
