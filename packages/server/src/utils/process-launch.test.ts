import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
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
import { createTreeCleanupChannel } from './tree-cleanup-channel.js'

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
  const ownershipToken = randomUUID()
  const env = buildPtyWrapperEnv({ ...process.env } as Record<string, string>, {}, ownershipToken)
  const wrapper = spawn(invocation.command, invocation.args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    env,
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
  return { wrapper, grandPid, ownershipToken }
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
        ELECTRON_RUN_AS_NODE: '1',
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

  it('should keep completion capability out of wrapped child env', () => {
    const wrapperEnv = buildPtyWrapperEnv(
      { PATH: '/usr/bin' },
      { AGENT_TOWER_TREE_CLEANUP_CHANNEL: '127.0.0.1:1234', AGENT_TOWER_TREE_CLEANUP_SECRET: 'parent-secret' },
      'launch-token',
      { AGENT_TOWER_TREE_CLEANUP_CHANNEL: '127.0.0.1:4321', AGENT_TOWER_TREE_CLEANUP_SECRET: 'launch-secret' },
    )

    expect(wrapperEnv).not.toHaveProperty('AGENT_TOWER_TREE_CLEANUP_CHANNEL')
    expect(wrapperEnv).not.toHaveProperty('AGENT_TOWER_TREE_CLEANUP_SECRET')
    expect(wrapperEnv).not.toHaveProperty('AGENT_TOWER_TREE_CLEANUP_EVIDENCE')
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

  it('should keep Unix group signals identity-validated with a handle-bound fallback', () => {
    const invocation = buildPtyCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'])
    const wrapperScript = invocation.args[1] ?? ''
    const directChildSignals = wrapperScript.match(/child\.kill\(signal\)/g) ?? []

    expect(wrapperScript).toContain('unixIdentityAdapter.signalGroup(signal)')
    expect(wrapperScript).toContain('process.kill(-child.pid, signal)')
    expect(wrapperScript).toContain("child['kill'](signal)")
    expect(directChildSignals).toHaveLength(1)
  })

  it.each([false, true])('cleans Windows descendants after root exit without signaling reused PIDs (reused=%s)', (reused) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 100, exitCode: null as number | null, signalCode: null, killed: false, kill: () => false,
    })
    let rows = [
      { ProcessId: 0, ParentProcessId: 0, CreationDate: '' },
      { ProcessId: 50, ParentProcessId: 1, CreationDate: 'wrapper-birth' },
      { ProcessId: 100, ParentProcessId: 50, CreationDate: 'root-birth' },
      { ProcessId: 101, ParentProcessId: 100, CreationDate: 'child-birth' },
    ]
    const targets: number[] = []
    const exits: number[] = []
    const wrapperProcess = Object.assign(new EventEmitter(), {
      argv: ['node', 'spawn', 'fake.exe'], platform: 'win32', pid: 50,
      env: { AGENT_TOWER_PROCESS_IDENTITY: 'test-owner' }, exit: (code: number) => exits.push(code),
    })
    runInNewContext(buildPtyCommand('fake.exe', []).args[1], {
      process: wrapperProcess, console,
      require: (name: string) => name === 'node:child_process' ? {
        spawn: () => child,
        spawnSync: (command: string, args: string[]) => {
          if (command === 'powershell.exe') return { status: 0, stdout: JSON.stringify(rows) }
          if (command !== 'taskkill') throw new Error(`Unexpected command: ${command}`)
          const pid = Number(args[1])
          targets.push(pid)
          if (!rows.some((row) => row.ProcessId === pid)) return { status: 128 }
          rows = rows.filter((row) => row.ProcessId !== pid && row.ParentProcessId !== pid)
          // A real Windows system always has other processes in its CIM table.
          if (rows.length === 0) rows.push({ ProcessId: 50, ParentProcessId: 1, CreationDate: 'wrapper-birth' })
          return { status: 0 }
        },
      } : { unlinkSync: () => undefined },
      setTimeout: () => ({ unref: () => undefined }), clearTimeout: () => undefined,
    })
    rows = reused
      ? rows.map((row) => ({ ...row, CreationDate: 'reused-birth' }))
      : rows.filter((row) => row.ProcessId !== 100)
    child.exitCode = 0
    child.emit('exit', 0, null)

    expect(targets).toEqual(reused ? [] : [101])
    expect(exits).toContain(0)
    if (reused) expect(rows.filter((row) => row.ProcessId >= 100).map((row) => row.ProcessId)).toEqual([100, 101])
  })

  it('should fail closed for unavailable process probes with bounded backoff', () => {
    const invocation = buildPtyCommand('C:\\Tools\\codex.cmd', ['--print'])
    const wrapperScript = invocation.args[1] ?? ''

    expect(wrapperScript).toContain("'PROBE_UNAVAILABLE'")
    expect(wrapperScript).toContain("'IDENTITY_INCOMPLETE'")
    expect(wrapperScript).toContain("'CLEAN_EMPTY'")
    expect(wrapperScript).toContain('scheduleTreePoll')
    expect(wrapperScript).not.toContain('treeExitPoll = setInterval')
  })

  it('should force a stable C locale for Unix process identity probes', () => {
    const invocation = buildPtyCommand(process.execPath, ['-e', 'process.exit(0)'])
    const wrapperScript = invocation.args[1] ?? ''

    expect(wrapperScript).toContain("probeEnv.LC_ALL = 'C'")
    expect(wrapperScript).toContain("probeEnv.LANG = 'C'")
  })

  it.skipIf(process.platform === 'win32')(
    'should keep the wrapper alive when a process probe returns an empty snapshot',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-tower-empty-probe-'))
      const fakePs = path.join(directory, 'ps')
      writeFileSync(fakePs, '#!/bin/sh\nexit 0\n')
      chmodSync(fakePs, 0o755)
      const invocation = buildPtyCommand(process.execPath, ['-e', 'process.exit(0)'])
      const wrapper = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: buildPtyWrapperEnv({
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ''}`,
        } as Record<string, string>, {}, randomUUID()),
      })
      try {
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(wrapper.exitCode).toBeNull()
      } finally {
        wrapper.kill('SIGKILL')
        await new Promise<void>((resolve) => wrapper.once('exit', () => resolve()))
        rmSync(directory, { recursive: true, force: true })
      }
    },
    5_000,
  )

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
    'should hard-escalate the verified wrapper tree when the child ignores termination',
    async () => {
      // The benign helper ignores graceful signals. The wrapper must retain
      // ownership long enough to escalate its known process group, so an
      // identity-failure cleanup cannot mistake wrapper exit for tree exit.
      const { wrapper, grandPid } = spawnWrapperWithGrandchild(`
        const { spawn } = require('node:child_process');
        const grand = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},60000)"], { stdio: 'ignore' });
        process.stdout.write('GRAND:' + grand.pid + '\\n');
        process.on('SIGINT', () => {});
        process.on('SIGTERM', () => {});
        setTimeout(() => {}, 60000);
      `)

      const pid = await grandPid
      expect(isAlive(pid)).toBe(true)

      wrapper.kill('SIGINT')
      await new Promise((resolve) => wrapper.on('exit', resolve))

      expect(await waitUntil(() => !isAlive(pid), 8000)).toBe(true)
    },
    15_000,
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

  it.skipIf(process.platform === 'win32')(
    'should discover and clean a detached descendant in a new process group',
    async () => {
      const { wrapper, grandPid } = spawnWrapperWithGrandchild(`
        const { spawn } = require('node:child_process');
        const grand = spawn(process.execPath, ['-e', "process.on('SIGHUP',()=>{});setInterval(()=>{},60000)"], { stdio: 'ignore', detached: true });
        grand.unref();
        process.stdout.write('GRAND:' + grand.pid + '\\n');
      `)

      const pid = await grandPid
      await new Promise((resolve) => wrapper.on('exit', resolve))

      expect(await waitUntil(() => !isAlive(pid), 8_000)).toBe(true)
    },
    15_000,
  )

  it.skipIf(process.platform === 'win32')(
    'should clean a descendant that does not inherit the ownership marker',
    async () => {
      const { wrapper, grandPid } = spawnWrapperWithGrandchild(`
        const { spawn } = require('node:child_process');
        const childEnv = { ...process.env };
        delete childEnv.AGENT_TOWER_PROCESS_IDENTITY;
        const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
          stdio: 'ignore',
          env: childEnv,
        });
        process.stdout.write('GRAND:' + grand.pid + '\\n');
        setTimeout(() => process.exit(0), 250);
      `)

      const pid = await grandPid
      await new Promise((resolve) => wrapper.on('exit', resolve))
      expect(await waitUntil(() => !isAlive(pid), 3_000)).toBe(true)
    },
    10_000,
  )

  it.skipIf(process.platform === 'win32')(
    'should keep completion parent-owned and hide it from the child',
    async () => {
      const channel = await createTreeCleanupChannel()
      const invocation = buildPtyCommand(process.execPath, [
        '-e',
        "process.stdout.write(JSON.stringify({ channel: process.env.AGENT_TOWER_TREE_CLEANUP_CHANNEL ?? null, secret: process.env.AGENT_TOWER_TREE_CLEANUP_SECRET ?? null, legacy: process.env.AGENT_TOWER_TREE_CLEANUP_EVIDENCE ?? null }))",
      ])
      const child = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: buildPtyWrapperEnv({ ...process.env } as Record<string, string>, {}, randomUUID(), channel.env),
      })
      let output = ''
      child.stdout!.on('data', (chunk) => { output += String(chunk) })
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', () => resolve())
      })
      expect(JSON.parse(output)).toEqual({ channel: null, secret: null, legacy: null })
      expect(channel.isCompleted()).toBe(false)
      channel.markCompleted()
      expect(channel.isCompleted()).toBe(true)
      channel.close()
    },
    10_000,
  )

  it.skipIf(process.platform === 'win32')(
    'should fail closed on a transient ps probe failure and recover before cleanup',
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-tower-ps-probe-'))
      const modeFile = path.join(directory, 'mode')
      const fakePs = path.join(directory, 'ps')
      writeFileSync(fakePs, '#!/bin/sh\nif test -f "$AGENT_TOWER_TEST_PS_MODE" && grep -q fail "$AGENT_TOWER_TEST_PS_MODE"; then exit 1; fi\nexec /bin/ps "$@"\n')
      chmodSync(fakePs, 0o755)
      writeFileSync(modeFile, 'ok')
      const invocation = buildPtyCommand(process.execPath, [
        '-e',
        [
          "const {spawn}=require('node:child_process');",
          "const grand=spawn(process.execPath,['-e','process.on(\\'SIGHUP\\',()=>{});setInterval(()=>{},60000)'],{stdio:'ignore'});",
          "process.stdout.write('GRAND:'+grand.pid+'\\n');",
          'setTimeout(() => process.exit(0), 250);',
        ].join(''),
      ])
      const wrapper = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...buildPtyWrapperEnv({ ...process.env } as Record<string, string>, {}, randomUUID()),
          PATH: `${directory}:${process.env.PATH ?? ''}`,
          AGENT_TOWER_TEST_PS_MODE: modeFile,
        },
      })
      let output = ''
      wrapper.stdout!.on('data', (chunk) => { output += String(chunk) })
      const grandPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for grandchild')), 5_000)
        wrapper.stdout!.on('data', () => {
          const match = output.match(/GRAND:(\d+)/)
          if (match) {
            clearTimeout(timer)
            resolve(Number(match[1]))
          }
        })
      })
      writeFileSync(modeFile, 'fail')
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(isAlive(wrapper.pid!)).toBe(true)
      expect(isAlive(grandPid)).toBe(true)

      writeFileSync(modeFile, 'ok')
      await new Promise<void>((resolve, reject) => {
        wrapper.once('error', reject)
        wrapper.once('exit', () => resolve())
      })
      expect(await waitUntil(() => !isAlive(grandPid), 8_000)).toBe(true)
      rmSync(directory, { recursive: true, force: true })
    },
    20_000,
  )
})
