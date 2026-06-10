import { execFileSync, spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPtyCommand,
  buildPtyCommandWithStdin,
  getDefaultTerminalShell,
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

  it('should normalize Windows command lookup output', () => {
    expect(normalizeCommandLookupOutput('C:\\Tools\\codex.cmd\r\nC:\\Other\\codex.cmd\r\n')).toBe('C:\\Tools\\codex.cmd')
  })

  it('should prefer .cmd/.exe over extensionless paths on Windows', () => {
    expect(normalizeCommandLookupOutput(
      'C:\\nvm4w\\nodejs\\claude\r\nC:\\nvm4w\\nodejs\\claude.cmd\r\n'
    )).toBe(process.platform === 'win32' ? 'C:\\nvm4w\\nodejs\\claude.cmd' : 'C:\\nvm4w\\nodejs\\claude')
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
