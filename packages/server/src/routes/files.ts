import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';

type FileItem = { name: string; type: 'file' | 'directory' };

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.avif',
]);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  '.pnpm',
  '.yarn',
]);

function handleError(error: unknown, reply: any) {
  if (error instanceof ZodError) {
    reply.code(400);
    return { error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors };
  }

  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as any).code as string;
    if (code === 'ENOENT') {
      reply.code(404);
      return { error: 'Not found', code: 'NOT_FOUND' };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      reply.code(403);
      return { error: 'Permission denied', code: 'PERMISSION_DENIED' };
    }
  }

  console.error('[files] Unhandled error:', error);
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

function normalizeUserPath(input: string | undefined) {
  const raw = (input ?? '').trim();
  if (!raw || raw === '/') return '';
  const noBackslash = raw.replace(/\\/g, '/');
  const stripped = noBackslash.startsWith('/') ? noBackslash.slice(1) : noBackslash;
  return stripped;
}

function assertNoTraversalSegments(relPath: string) {
  const segments = relPath.split('/').filter(Boolean);
  if (segments.some((s) => s === '..')) {
    throw new ZodError([
      {
        code: 'custom',
        message: 'Path traversal (..) is not allowed',
        path: ['path'],
      } as any,
    ]);
  }
}

async function resolveInWorkingDir(workingDir: string, userPath: string | undefined) {
  const baseReal = await fs.realpath(workingDir);
  const rel = normalizeUserPath(userPath);
  assertNoTraversalSegments(rel);
  const abs = path.resolve(baseReal, rel);
  const relative = path.relative(baseReal, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const err: any = new Error('Resolved path is outside workingDir');
    err.code = 'OUTSIDE_WORKING_DIR';
    throw err;
  }
  return { baseReal, rel, abs };
}

function inferLanguage(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.json':
      return 'json';
    case '.md':
    case '.mdx':
      return 'markdown';
    case '.css':
      return 'css';
    case '.scss':
      return 'scss';
    case '.html':
      return 'html';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.sh':
      return 'shell';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    default:
      return 'plaintext';
  }
}

const treeQuerySchema = z.object({
  path: z.string().optional(),
  workingDir: z
    .string()
    .min(1, 'workingDir is required')
    .refine((v) => path.isAbsolute(v), { message: 'workingDir must be absolute' })
    .refine((v) => !v.split(path.sep).includes('..'), {
      message: 'Path traversal (..) is not allowed',
    }),
});

const readQuerySchema = z.object({
  path: z.string().min(1, 'path is required'),
  workingDir: z
    .string()
    .min(1, 'workingDir is required')
    .refine((v) => path.isAbsolute(v), { message: 'workingDir must be absolute' })
    .refine((v) => !v.split(path.sep).includes('..'), {
      message: 'Path traversal (..) is not allowed',
    }),
});

const writeBodySchema = z.object({
  path: z.string().min(1, 'path is required'),
  workingDir: z
    .string()
    .min(1, 'workingDir is required')
    .refine((v) => path.isAbsolute(v), { message: 'workingDir must be absolute' })
    .refine((v) => !v.split(path.sep).includes('..'), {
      message: 'Path traversal (..) is not allowed',
    }),
  content: z.string(),
});

export async function filesRoutes(app: FastifyInstance) {
  /**
   * GET /tree?path=/&workingDir=/abs/path
   * 列出指定目录下一层文件/文件夹（不递归）
   */
  app.get('/tree', async (request, reply) => {
    try {
      const { path: userPath, workingDir } = treeQuerySchema.parse(request.query);
      if (!fssync.existsSync(workingDir)) {
        reply.code(400);
        return { error: `workingDir does not exist: ${workingDir}`, code: 'WORKING_DIR_NOT_FOUND' };
      }

      const { baseReal, abs } = await resolveInWorkingDir(workingDir, userPath);
      const dirReal = await fs.realpath(abs);
      const relative = path.relative(baseReal, dirReal);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        reply.code(400);
        return { error: 'Path is outside workingDir', code: 'OUTSIDE_WORKING_DIR' };
      }

      const stat = await fs.stat(dirReal);
      if (!stat.isDirectory()) {
        reply.code(400);
        return { error: 'path is not a directory', code: 'NOT_A_DIRECTORY' };
      }

      const entries = await fs.readdir(dirReal, { withFileTypes: true });
      const items: FileItem[] = entries
        .filter((e) => {
          if (e.isDirectory()) return !IGNORED_DIRS.has(e.name);
          // ignore some noisy files
          if (e.name === '.DS_Store') return false;
          return true;
        })
        .map((e) => {
          const type: FileItem['type'] = e.isDirectory() ? 'directory' : 'file';
          return { name: e.name, type };
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return { items };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as any).code === 'OUTSIDE_WORKING_DIR') {
        reply.code(400);
        return { error: 'Path is outside workingDir', code: 'OUTSIDE_WORKING_DIR' };
      }
      return handleError(error, reply);
    }
  });

  /**
   * GET /read?path=src/auth/Login.tsx&workingDir=/abs/path
   * 读取文件内容
   */
  app.get('/read', async (request, reply) => {
    try {
      const { path: userFilePath, workingDir } = readQuerySchema.parse(request.query);
      if (!fssync.existsSync(workingDir)) {
        reply.code(400);
        return { error: `workingDir does not exist: ${workingDir}`, code: 'WORKING_DIR_NOT_FOUND' };
      }

      const { baseReal, abs } = await resolveInWorkingDir(workingDir, userFilePath);
      const fileReal = await fs.realpath(abs);
      const relative = path.relative(baseReal, fileReal);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        reply.code(400);
        return { error: 'Path is outside workingDir', code: 'OUTSIDE_WORKING_DIR' };
      }

      const stat = await fs.stat(fileReal);
      if (!stat.isFile()) {
        reply.code(400);
        return { error: 'path is not a file', code: 'NOT_A_FILE' };
      }

      const content = await fs.readFile(fileReal, 'utf8');
      return { content, language: inferLanguage(userFilePath) };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as any).code === 'OUTSIDE_WORKING_DIR') {
        reply.code(400);
        return { error: 'Path is outside workingDir', code: 'OUTSIDE_WORKING_DIR' };
      }
      return handleError(error, reply);
    }
  });

  /**
   * POST /write { path, workingDir, content }
   * 保存文件内容
   */
  app.post('/write', async (request, reply) => {
    try {
      const { path: userFilePath, workingDir, content } = writeBodySchema.parse(request.body || {});
      if (!fssync.existsSync(workingDir)) {
        reply.code(400);
        return { error: `workingDir does not exist: ${workingDir}`, code: 'WORKING_DIR_NOT_FOUND' };
      }

      const { baseReal, abs } = await resolveInWorkingDir(workingDir, userFilePath);

      // Ensure parent dir exists and is within workingDir (mitigate symlink escapes)
      const parent = path.dirname(abs);
      const parentReal = await fs.realpath(parent);
      const parentRel = path.relative(baseReal, parentReal);
      if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) {
        reply.code(400);
        return { error: 'Path is outside workingDir', code: 'OUTSIDE_WORKING_DIR' };
      }

      await fs.writeFile(abs, content, 'utf8');
      return { success: true };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as any).code === 'OUTSIDE_WORKING_DIR') {
        reply.code(400);
        return { error: 'Path is outside workingDir', code: 'OUTSIDE_WORKING_DIR' };
      }
      return handleError(error, reply);
    }
  });

  /**
   * GET /image?path=assets/logo.png&workingDir=/abs/path
   * 返回图片文件的原始二进制数据
   */
  app.get('/image', async (request, reply) => {
    try {
      const { path: userFilePath, workingDir } = readQuerySchema.parse(request.query);
      if (!fssync.existsSync(workingDir)) {
        reply.code(400);
        return { error: `workingDir does not exist: ${workingDir}`, code: 'WORKING_DIR_NOT_FOUND' };
      }

      const { baseReal, abs } = await resolveInWorkingDir(workingDir, userFilePath);
      const fileReal = await fs.realpath(abs);
      const relative = path.relative(baseReal, fileReal);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        reply.code(400);
        return { error: 'Path is outside workingDir', code: 'OUTSIDE_WORKING_DIR' };
      }

      const stat = await fs.stat(fileReal);
      if (!stat.isFile()) {
        reply.code(400);
        return { error: 'path is not a file', code: 'NOT_A_FILE' };
      }

      const ext = path.extname(fileReal).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        reply.code(400);
        return { error: 'Not an image file', code: 'NOT_IMAGE' };
      }

      const mime = MIME_MAP[ext] || 'application/octet-stream';
      const buffer = await fs.readFile(fileReal);
      reply.header('Content-Type', mime);
      reply.header('Cache-Control', 'no-cache');
      return reply.send(buffer);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as any).code === 'OUTSIDE_WORKING_DIR') {
        reply.code(400);
        return { error: 'Path is outside workingDir', code: 'OUTSIDE_WORKING_DIR' };
      }
      return handleError(error, reply);
    }
  });
}

