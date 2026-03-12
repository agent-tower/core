/**
 * 图片处理工具模块
 * 用于解析 Markdown 中的图片、读取图片文件并转换为 base64
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 图片内容块
 */
export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

/**
 * 文本内容块
 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * 内容块类型
 */
export type ContentBlock = ImageBlock | TextBlock;

/**
 * 解析后的 prompt
 */
export interface ParsedPrompt {
  contentBlocks: ContentBlock[];
  hasImages: boolean;
}

/**
 * MIME 类型映射
 */
const MIME_TYPE_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * 根据文件扩展名获取 MIME 类型
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPE_MAP[ext] || 'application/octet-stream';
}

/**
 * 读取图片文件并转换为 base64
 */
export async function readImageAsBase64(filePath: string): Promise<string> {
  try {
    const buffer = await fs.readFile(filePath);
    return buffer.toString('base64');
  } catch (error) {
    throw new Error(`Failed to read image file: ${filePath}. Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 检查文件是否存在
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 Markdown 中的图片语法并转换为 content blocks
 * 支持格式：![alt](path)
 */
export async function parsePromptWithImages(prompt: string): Promise<ParsedPrompt> {
  // 匹配 ![alt](path) 格式的图片
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

  const contentBlocks: ContentBlock[] = [];
  let hasImages = false;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // 遍历所有匹配的图片
  while ((match = imageRegex.exec(prompt)) !== null) {
    const [fullMatch, _alt, imagePath] = match;
    const matchIndex = match.index;

    // 添加图片前的文本
    if (matchIndex > lastIndex) {
      const textBefore = prompt.substring(lastIndex, matchIndex).trim();
      if (textBefore) {
        contentBlocks.push({
          type: 'text',
          text: textBefore,
        });
      }
    }

    // 检查图片文件是否存在
    const exists = await fileExists(imagePath);
    if (!exists) {
      console.warn(`[image-utils] Image file not found: ${imagePath}`);
      // 如果文件不存在，保留原始 Markdown 文本
      contentBlocks.push({
        type: 'text',
        text: fullMatch,
      });
    } else {
      try {
        // 读取图片并转换为 base64
        const base64Data = await readImageAsBase64(imagePath);
        const mimeType = getMimeType(imagePath);

        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data: base64Data,
          },
        });

        hasImages = true;
        console.log(`[image-utils] Successfully loaded image: ${imagePath} (${mimeType})`);
      } catch (error) {
        console.error(`[image-utils] Failed to load image: ${imagePath}`, error);
        // 如果读取失败，保留原始 Markdown 文本
        contentBlocks.push({
          type: 'text',
          text: fullMatch,
        });
      }
    }

    lastIndex = matchIndex + fullMatch.length;
  }

  // 添加剩余的文本
  if (lastIndex < prompt.length) {
    const textAfter = prompt.substring(lastIndex).trim();
    if (textAfter) {
      contentBlocks.push({
        type: 'text',
        text: textAfter,
      });
    }
  }

  // 如果没有找到任何图片，返回原始文本
  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: 'text',
      text: prompt,
    });
  }

  return {
    contentBlocks,
    hasImages,
  };
}

/**
 * 构造 Claude Code CLI 格式的用户消息（NDJSON 格式）
 * 用于通过 stdin 发送给 Claude Code CLI
 *
 * 根据 claude-cli-agent-protocol 文档，格式应该是：
 * {"type":"user","message":{"role":"user","content":[...]}}
 */
export function buildUserMessageNDJSON(contentBlocks: ContentBlock[]): string {
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: contentBlocks,
    },
  };

  // 返回 NDJSON 格式（单行 JSON + 换行符）
  return JSON.stringify(message) + '\n';
}
