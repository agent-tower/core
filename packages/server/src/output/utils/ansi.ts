/**
 * ANSI 转义序列处理工具
 */

/**
 * 匹配常见 ANSI 转义序列的正则：
 * - CSI 序列: ESC [ ... 最终字符 (包括 ?25h, ?25l 等私有模式序列)
 * - OSC 序列: ESC ] ... ST
 * - 简单双字符序列: ESC 后跟单个字符 (如 ESC(B 等)
 */
const ANSI_REGEX = /\x1b(?:\[[0-9;?<>=]*[a-zA-Z@`]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()#][A-Z0-9]|[A-Z=><])/g;

/**
 * 剥离字符串中的所有 ANSI 转义序列
 */
export function stripAnsiSequences(text: string): string {
  return text.replace(ANSI_REGEX, '');
}
