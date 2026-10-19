// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { readTerminalTheme } from '../terminal-theme'

/** The xterm-facing tokens from src/index.css (Vitest stubs CSS imports, so they are set by hand here). */
const TOKENS: Record<string, string> = {
  '--terminal': '#1e1e1e',
  '--terminal-foreground': '#d4d4d4',
  '--terminal-selection': '#264f78',
  '--terminal-red': '#f44747',
  '--terminal-green': '#6a9955',
  '--terminal-yellow': '#d7ba7d',
  '--terminal-blue': '#569cd6',
  '--terminal-magenta': '#c586c0',
  '--terminal-cyan': '#4ec9b0',
  '--terminal-bright-black': '#808080',
  '--terminal-bright-white': '#ffffff',
}

describe('readTerminalTheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('maps the --terminal-* tokens onto xterm theme keys', () => {
    for (const [name, value] of Object.entries(TOKENS)) {
      document.documentElement.style.setProperty(name, value)
    }

    const theme = readTerminalTheme()

    for (const [key, value] of Object.entries(theme)) {
      expect(value, key).not.toBe('')
    }
    expect(theme.background).toBe('#1e1e1e')
    expect(theme.selectionBackground).toBe('#264f78')
    expect(theme.black).toBe(theme.background)
    expect(theme.white).toBe(theme.foreground)
    expect(theme.cursor).toBe(theme.foreground)
    expect(theme.brightRed).toBe(theme.red)
    expect(theme.brightCyan).toBe(theme.cyan)
    expect(theme.brightBlack).toBe('#808080')
    expect(theme.brightWhite).toBe('#ffffff')
  })

  it('reads the tokens from the element it is given', () => {
    const host = document.createElement('div')
    host.style.setProperty('--terminal', '#000000')
    document.body.appendChild(host)

    expect(readTerminalTheme(host).background).toBe('#000000')

    host.remove()
  })
})
