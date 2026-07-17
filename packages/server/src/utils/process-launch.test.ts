import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildWindowsCmdShimCommandLine,
  buildPtyWrapperEnv,
  buildPtyCommand,
  buildPtyCommandWithStdin,
  buildUnixPathWithUserBinFallbacks,
  buildWindowsPathWithUserBinFallbacks,
  getDefaultTerminalShell,
  getNodeRuntimeCommand,
  normalizeCommandLookupOutput,
} from './process-launch.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

/** 启动 wrapper 运行 childScript，等待 child 打印的孙进程 PID */
function spawnWrapperWithGrandchild(childScript: string) {
  const invocation = buildPtyCommand(process.execPath, ['-e', childScript])
  const wrapper = spawn(invocation.command, invocation.args, {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const grandPid = new Promise<number>((resolve, reject) => {
    let buf = ''
    wrapper.stdout!.on('data', (chunk) => {
      buf += String(chunk)
      const match = buf.match(/GRAND:(\d+)/)
      if (match) resolve(Number(match[1]))
    })
    setTimeout(() => reject(new Error('timed out waiting for grandchild pid')), 5000).unref()
  })
  return { wrapper, grandPid }
}

describe('process-launch', () => {
  it('should add bundled node runtime env only to the PTY wrapper env', () => {
    const wrapperEnv = buildPtyWrapperEnv(
      {
        PATH: '/usr/bin',
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      },
      {
        AGENT_TOWER_NODE_RUNTIME: 'C:\\Program Files\\Agent Tower\\resources\\runtime\\node\\node.exe',
      },
    )

    expect(wrapperEnv).toMatchObject({
      PATH: '/usr/bin',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_NODE_RUNTIME: 'C:\\Program Files\\Agent Tower\\resources\\runtime\\node\\node.exe',
    })
    expect(wrapperEnv).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('should preserve Electron node-mode env only for packaged fallback runtimes', () => {
    const wrapperEnv = buildPtyWrapperEnv(
      {
        PATH: '/usr/bin',
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      },
      {
        AGENT_TOWER_NODE_RUNTIME: 'C:\\Program Files\\Agent Tower\\resources\\runtime\\node\\node.exe',
      },
    )

    expect(wrapperEnv).toMatchObject({
      PATH: '/usr/bin',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_NODE_RUNTIME: 'C:\\Program Files\\Agent Tower\\resources\\runtime\\node\\node.exe',
    })
    expect(wrapperEnv).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('should preserve Electron node-mode env only for packaged fallback runtimes', () => {
    const wrapperEnv = buildPtyWrapperEnv(
      {
        PATH: '/usr/bin',
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      },
      {
        AGENT_TOWER_NODE_RUNTIME: '/Applications/Agent Tower.app/Contents/MacOS/Agent Tower',
        ELECTRON_RUN_AS_NODE: '1',
      },
    )

    expect(wrapperEnv).toMatchObject({
      PATH: '/usr/bin',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_NODE_RUNTIME: '/Applications/Agent Tower.app/Contents/MacOS/Agent Tower',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('should leave npm CLI wrapper env unchanged when packaged env is absent', () => {
    const agentEnv = {
      PATH: '/usr/bin',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
    }

    expect(buildPtyWrapperEnv(agentEnv, {})).toEqual(agentEnv)
  })

  it('should strip packaged node-mode env before spawning the wrapped child', () => {
    const originalNodeRuntime = process.env.AGENT_TOWER_NODE_RUNTIME
    delete process.env.AGENT_TOWER_NODE_RUNTIME

    try {
      const invocation = buildPtyCommand(process.execPath, [
        '-e',
        [
          'process.stdout.write(JSON.stringify({',
          'nodeRuntime: process.env.AGENT_TOWER_NODE_RUNTIME ?? null,',
          'electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
          'marker: process.env.AGENT_TOWER_TEST_NORMAL_ENV ?? null',
          '}))',
        ].join(''),
      ])
      const agentEnv = {
        ...process.env,
        AGENT_TOWER_TEST_NORMAL_ENV: 'keep-me',
      } as Record<string, string>
      delete agentEnv.AGENT_TOWER_NODE_RUNTIME
      delete agentEnv.ELECTRON_RUN_AS_NODE
      const stdout = execFileSync(invocation.command, invocation.args, {
        encoding: 'utf-8',
        env: buildPtyWrapperEnv(agentEnv, {
          AGENT_TOWER_NODE_RUNTIME: 'C:\\Program Files\\Agent Tower\\Agent Tower.exe',
          ELECTRON_RUN_AS_NODE: '1',
        }),
      })

      expect(JSON.parse(stdout)).toEqual({
        nodeRuntime: null,
        electronRunAsNode: null,
        marker: 'keep-me',
      })
    } finally {
      if (originalNodeRuntime === undefined) {
        delete process.env.AGENT_TOWER_NODE_RUNTIME
      } else {
        process.env.AGENT_TOWER_NODE_RUNTIME = originalNodeRuntime
      }
    }
  })

  it('should preserve arguments through the PTY wrapper', () => {
    const invocation = buildPtyCommand(process.execPath, [
      '-e',
      'process.stdout.write(process.argv.slice(1).join("|"))',
      'hello world',
      `quote's test`,
    ])

    const stdout = execFileSync(invocation.command, invocation.args, {
      encoding: 'utf-8',
    })

    expect(stdout).toBe(`hello world|quote's test`)
  })

  it('should pipe stdin from a temp file and delete it afterwards', () => {
    const tmpFile = path.join(os.tmpdir(), `agent-tower-test-${Date.now()}.txt`)
    writeFileSync(tmpFile, '{"message":"hello"}', 'utf-8')

    const invocation = buildPtyCommandWithStdin(process.execPath, [
      '-e',
      [
        "process.stdin.setEncoding('utf8')",
        "let data = ''",
        "process.stdin.on('data', chunk => { data += chunk })",
        "process.stdin.on('end', () => { process.stdout.write(data) })",
      ].join(';'),
    ], tmpFile)

    const stdout = execFileSync(invocation.command, invocation.args, {
      encoding: 'utf-8',
    })

    expect(stdout).toBe('{"message":"hello"}')
    expect(existsSync(tmpFile)).toBe(false)
  })

  it('should delete the stdin temp file when the child exits without reading stdin', () => {
    const tmpFile = path.join(os.tmpdir(), `agent-tower-test-early-exit-${Date.now()}.txt`)
    writeFileSync(tmpFile, 'x'.repeat(1024 * 1024), 'utf-8')

    try {
      const invocation = buildPtyCommandWithStdin(process.execPath, [
        '-e',
        'process.exit(0)',
      ], tmpFile)

      execFileSync(invocation.command, invocation.args, {
        encoding: 'utf-8',
      })

      expect(existsSync(tmpFile)).toBe(false)
    } finally {
      rmSync(tmpFile, { force: true })
    }
  })

  it('should preserve the child exit code when stdin pipe breaks on early exit', () => {
    const tmpFile = path.join(os.tmpdir(), `agent-tower-test-early-exit-code-${Date.now()}.txt`)
    writeFileSync(tmpFile, 'x'.repeat(1024 * 1024), 'utf-8')

    try {
      const invocation = buildPtyCommandWithStdin(process.execPath, [
        '-e',
        'process.exit(42)',
      ], tmpFile)

      const result = spawnSync(invocation.command, invocation.args, {
        encoding: 'utf-8',
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(42)
      expect(existsSync(tmpFile)).toBe(false)
    } finally {
      rmSync(tmpFile, { force: true })
    }
  })

  it('should keep long stdin data out of Windows .cmd/.bat command lines', () => {
    const marker = 'WINDOWS_LONG_PROMPT_MARKER'
    const longPrompt = `${marker}${'x'.repeat(32_000)}`
    const stdinFile = path.join(os.tmpdir(), 'agent-tower-long-prompt-test.txt')
    const invocation = buildPtyCommandWithStdin(
      'C:\\Tools\\cursor-agent.cmd',
      ['--print', '--output-format=stream-json'],
      stdinFile,
    )

    expect(longPrompt).toContain(marker)
    expect(JSON.stringify(invocation.args)).not.toContain(marker)

    const modeIndex = invocation.args.indexOf('pipe-file')
    expect(modeIndex).toBeGreaterThanOrEqual(0)
    const childProgram = invocation.args[modeIndex + 1]!
    const childArgs = invocation.args.slice(modeIndex + 3)
    const cmdLine = buildWindowsCmdShimCommandLine(childProgram, childArgs)

    expect(cmdLine).toContain('cursor-agent.cmd')
    expect(cmdLine).toContain('--print')
    expect(cmdLine).not.toContain(marker)
    expect(cmdLine).not.toContain(stdinFile)
  })

  it('should hide Windows consoles for wrapper-spawned child processes', () => {
    const invocation = buildPtyCommand('C:\\Tools\\cursor-agent.cmd', ['--print'])

    expect(invocation.args[1]).toContain('windowsHide: true')
  })

  it('should allow overriding the node-like runtime command', () => {
    const original = process.env.AGENT_TOWER_NODE_RUNTIME
    process.env.AGENT_TOWER_NODE_RUNTIME = '/tmp/agent-tower-node-runtime'

    try {
      expect(getNodeRuntimeCommand()).toBe('/tmp/agent-tower-node-runtime')
      expect(buildPtyCommand('echo', ['ok']).command).toBe('/tmp/agent-tower-node-runtime')
    } finally {
      if (original === undefined) {
        delete process.env.AGENT_TOWER_NODE_RUNTIME
      } else {
        process.env.AGENT_TOWER_NODE_RUNTIME = original
      }
    }
  })

  it('should normalize Windows command lookup output', () => {
    expect(normalizeCommandLookupOutput('C:\\Tools\\codex.cmd\r\nC:\\Other\\codex.cmd\r\n', 'win32')).toBe('C:\\Tools\\codex.cmd')
  })

  it('should prefer .cmd/.exe over extensionless paths on Windows', () => {
    expect(normalizeCommandLookupOutput(
      'C:\\nvm4w\\nodejs\\claude\r\nC:\\nvm4w\\nodejs\\claude.cmd\r\n',
      'win32',
    )).toBe('C:\\nvm4w\\nodejs\\claude.cmd')
  })

  it('should keep extensionless lookup preference on Unix', () => {
    expect(normalizeCommandLookupOutput(
      '/usr/local/bin/claude\n/usr/local/bin/claude.cmd\n',
      'linux',
    )).toBe('/usr/local/bin/claude')
  })

  it('should append common Windows user bin directories without duplicating PATH entries', () => {
    const nextPath = buildWindowsPathWithUserBinFallbacks({
      Path: 'C:\\Windows\\System32;C:\\Users\\alice\\AppData\\Roaming\\npm',
      USERPROFILE: 'C:\\Users\\alice',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
    })

    expect(nextPath?.split(';')).toEqual([
      'C:\\Windows\\System32',
      'C:\\Users\\alice\\AppData\\Roaming\\npm',
      'C:\\Users\\alice\\.local\\bin',
      'C:\\Users\\alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin',
      'C:\\Users\\alice\\AppData\\Local\\Programs\\codex\\bin',
      'C:\\Users\\alice\\AppData\\Local\\Programs\\Claude\\bin',
      'C:\\Users\\alice\\AppData\\Local\\Programs\\Cursor\\bin',
      'C:\\Users\\alice\\AppData\\Local\\cursor-agent',
    ])
  })

  it('should append macOS user CLI directories and discovered nvm bins', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'agent-tower-unix-path-'))
    const nvmBin = path.join(home, '.nvm', 'versions', 'node', 'v22.12.0', 'bin')
    mkdirSync(nvmBin, { recursive: true })

    try {
      const nextPath = buildUnixPathWithUserBinFallbacks({
        PATH: '/usr/bin',
        HOME: home,
      }, 'darwin')

      expect(nextPath?.split(':')).toEqual(expect.arrayContaining([
        '/usr/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        path.join(home, 'Library', 'pnpm'),
        nvmBin,
        '/opt/homebrew/bin',
      ]))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('should resolve terminal shells per platform', () => {
    expect(getDefaultTerminalShell('win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
    })

    expect(getDefaultTerminalShell('darwin', { SHELL: '/bin/bash' })).toEqual({
      command: '/bin/bash',
      args: [],
    })
  })

  it.skipIf(process.platform === 'win32')(
    'should kill grandchild processes when the wrapper receives a termination signal',
    async () => {
      // child 启动一个长睡眠孙进程后自己也保持运行
      const { wrapper, grandPid } = spawnWrapperWithGrandchild(`
        const { spawn } = require('node:child_process');
        const grand = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        process.stdout.write('GRAND:' + grand.pid + '\\n');
        setTimeout(() => {}, 60000);
      `)

      const pid = await grandPid
      expect(isAlive(pid)).toBe(true)

      wrapper.kill('SIGTERM')
      await new Promise((resolve) => wrapper.on('exit', resolve))

      // killTree 应通过进程组信号清掉孙进程，而不仅是直接 child
      expect(await waitUntil(() => !isAlive(pid), 3000)).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'should sweep leftover grandchildren after the child exits normally',
    async () => {
      // child 留下一个后台孙进程后立即正常退出
      const { wrapper, grandPid } = spawnWrapperWithGrandchild(`
        const { spawn } = require('node:child_process');
        const grand = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        grand.unref();
        process.stdout.write('GRAND:' + grand.pid + '\\n');
      `)

      const pid = await grandPid
      await new Promise((resolve) => wrapper.on('exit', resolve))

      // exitWithChildResult 应在退出前对 child 进程组发 SIGHUP 清扫残留
      expect(await waitUntil(() => !isAlive(pid), 3000)).toBe(true)
    }
  )
})
