import { execFileSync } from 'node:child_process'
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
})
