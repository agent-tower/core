import type { FastifyInstance } from 'fastify';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { prisma } from '../utils/index.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/** 附件存储根目录 */
function getStorageDir(): string {
  const dataDir = process.env.AGENT_TOWER_DATA_DIR || process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
  return path.join(dataDir, 'attachments');
}

/** 确保存储目录存在 */
async function ensureStorageDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function attachmentRoutes(app: FastifyInstance) {
  /**
   * POST /upload
   * multipart/form-data 上传文件
   */
  app.post('/upload', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { error: 'No file provided' };
    }

    // 读取文件内容到 buffer
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of file.file) {
      totalSize += chunk.length;
      if (totalSize > MAX_FILE_SIZE) {
        reply.code(413);
        return { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` };
      }
      chunks.push(chunk);
    }

    // 检查 busboy 是否因为大小限制截断了文件
    if (file.file.truncated) {
      reply.code(413);
      return { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` };
    }
    const buffer = Buffer.concat(chunks);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    // 检查是否已存在相同 hash 的文件
    const existing = await prisma.attachment.findFirst({ where: { hash } });
    if (existing) {
      return {
        id: existing.id,
        originalName: existing.originalName,
        mimeType: existing.mimeType,
        sizeBytes: existing.sizeBytes,
        url: `/attachments/${existing.id}/file`,
        storagePath: existing.storagePath,
      };
    }

    // 存储文件: data/attachments/{hash前2位}/{hash}_{原始文件名}
    const storageDir = getStorageDir();
    const subDir = path.join(storageDir, hash.slice(0, 2));
    await ensureStorageDir(subDir);

    const safeName = (file.filename || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = path.join(subDir, `${hash}_${safeName}`);
    await fs.writeFile(storagePath, buffer);

    const attachment = await prisma.attachment.create({
      data: {
        originalName: file.filename || 'upload',
        mimeType: file.mimetype || 'application/octet-stream',
        sizeBytes: buffer.length,
        storagePath,
        hash,
      },
    });

    return {
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      url: `/attachments/${attachment.id}/file`,
      storagePath: attachment.storagePath,
    };
  });

  /**
   * GET /:id/file
   * 获取附件文件内容
   */
  app.get<{ Params: { id: string } }>('/:id/file', async (request, reply) => {
    const attachment = await prisma.attachment.findUnique({
      where: { id: request.params.id },
    });
    if (!attachment) {
      reply.code(404);
      return { error: 'Attachment not found' };
    }

    if (!fssync.existsSync(attachment.storagePath)) {
      reply.code(404);
      return { error: 'File not found on disk' };
    }

    const stream = fssync.createReadStream(attachment.storagePath);
    return reply
      .type(attachment.mimeType)
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(attachment.originalName)}"`)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(stream);
  });

  /**
   * GET /by-path?path=/abs/path/to/file
   * 通过磁盘路径获取附件（仅允许 data/attachments/ 目录下的文件）
   */
  app.get('/by-path', async (request, reply) => {
    const { path: filePath } = request.query as { path?: string };
    if (!filePath) {
      reply.code(400);
      return { error: 'path query parameter is required' };
    }

    // 安全校验：必须在 attachments 存储目录下
    const storageDir = path.resolve(getStorageDir());
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(storageDir)) {
      reply.code(403);
      return { error: 'Access denied: path is outside attachments directory' };
    }

    if (!fssync.existsSync(resolved)) {
      reply.code(404);
      return { error: 'File not found' };
    }

    // 从文件扩展名推断 MIME 类型
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf', '.txt': 'text/plain',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    const stream = fssync.createReadStream(resolved);
    return reply
      .type(mimeType)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(stream);
  });
}
