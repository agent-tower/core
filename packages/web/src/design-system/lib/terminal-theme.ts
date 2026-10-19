/** 键名与 xterm 的 ITheme 一致，可以直接传给 `new Terminal({ theme })` */
export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/**
 * 终端配色的实际值。xterm 自己画 canvas、读不了 CSS 变量，创建终端时调用一次，
 * 把 index.css 里的 --terminal-* 换成色值；亮色版（bright*）除黑白外与常规色相同。
 * 终端外面的界面层直接写类名：bg-terminal、bg-terminal-chrome、border-terminal-border 等。
 */
export function readTerminalTheme(root: Element = document.documentElement): TerminalTheme {
  const style = getComputedStyle(root)
  const read = (name: string) => style.getPropertyValue(name).trim()
  const background = read('--terminal')
  const foreground = read('--terminal-foreground')
  const red = read('--terminal-red')
  const green = read('--terminal-green')
  const yellow = read('--terminal-yellow')
  const blue = read('--terminal-blue')
  const magenta = read('--terminal-magenta')
  const cyan = read('--terminal-cyan')
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground: read('--terminal-selection'),
    black: background,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: foreground,
    brightBlack: read('--terminal-bright-black'),
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: read('--terminal-bright-white'),
  }
}
