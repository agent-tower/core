import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * 查询参数校验：path 必须是绝对路径且不含 ".." 片段
 */
const browseQuerySchema = z.object({
  path: z
    .string()
    .optional()
    .default('')
    .transform((v) => v || os.homedir())
    .refine((v) => path.isAbsolute(v), { message: 'path must be absolute' })
    .refine((v) => !v.split(path.sep).includes('..'), {
      message: 'Path traversal (..) is not allowed',
    }),
});

const validateQuerySchema = z.object({
  path: z
    .string()
    .min(1, 'path is required')
    .refine((v) => path.isAbsolute(v), { message: 'path must be absolute' })
    .refine((v) => !v.split(path.sep).includes('..'), {
      message: 'Path traversal (..) is not allowed',
    }),
});

/**
 * 统一错误处理
 */
function handleError(error: unknown, reply: any) {
  if (error instanceof ZodError) {
    const fieldErrors = error.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    reply.code(400);
    return { error: 'Validation failed', code: 'VALIDATION_ERROR', details: fieldErrors };
  }

  console.error('[filesystem] Unhandled error:', error);
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

const completeQuerySchema = z.object({
  basePath: z
    .string()
    .min(1, 'basePath is required')
    .refine((v) => path.isAbsolute(v), { message: 'basePath must be absolute' }),
  prefix: z.string().default(''),
});

export async function filesystemRoutes(app: FastifyInstance) {
  /**
   * GET /complete?basePath=<repo>&prefix=<partial>
   * 文件路径自动补全：列出 basePath 下匹配 prefix 的文件和目录
   */
  app.get('/complete', async (request, reply) => {
    try {
      const { basePath: base, prefix } = completeQuerySchema.parse(request.query);

      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
        return { results: [] };
      }

      // 拆分 prefix 为目录部分和名称前缀（同时识别 / 和 \）
      const lastSlash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
      const dirPart = lastSlash >= 0 ? prefix.slice(0, lastSlash) : '';
      const namePart = lastSlash >= 0 ? prefix.slice(lastSlash + 1) : prefix;
      const searchDir = path.join(base, dirPart);

      if (!fs.existsSync(searchDir) || !fs.statSync(searchDir).isDirectory()) {
        return { results: [] };
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(searchDir, { withFileTypes: true });
      } catch {
        return { results: [] };
      }

      const IGNORED = new Set(['.git', '.hg', '.svn']);
      const namePrefix = namePart.toLowerCase();

      const results = entries
        .filter((e) => {
          if (IGNORED.has(e.name)) return false;
          return e.name.toLowerCase().startsWith(namePrefix);
        })
        .slice(0, 20)
        .map((e) => {
          const isDir = e.isDirectory();
          const relativePath = dirPart ? `${dirPart}/${e.name}` : e.name;
          return {
            name: e.name,
            path: isDir ? `${relativePath}/` : relativePath,
            type: isDir ? 'directory' as const : 'file' as const,
          };
        })
        .sort((a, b) => {
          // 目录优先
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return { results };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /browse?path=<dir>
   * 列出指定目录下的子目录（不列文件），返回每个目录的 isGitRepo 标记
   */
  app.get('/browse', async (request, reply) => {
    try {
      const { path: dirPath } = browseQuerySchema.parse(request.query);

      // 检查目录是否存在
      if (!fs.existsSync(dirPath)) {
        reply.code(400);
        return { error: `Directory does not exist: ${dirPath}`, code: 'DIR_NOT_FOUND' };
      }

      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        reply.code(400);
        return { error: `Path is not a directory: ${dirPath}`, code: 'NOT_A_DIRECTORY' };
      }

      // 读取子条目，仅保留目录
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        reply.code(403);
        return { error: `Permission denied: ${dirPath}`, code: 'PERMISSION_DENIED' };
      }

      const dirs = entries
        .filter((entry) => {
          try {
            return entry.isDirectory() && !entry.name.startsWith('.');
          } catch {
            return false;
          }
        })
        .map((entry) => {
          const fullPath = path.join(dirPath, entry.name);
          const gitPath = path.join(fullPath, '.git');
          let isGitRepo = false;
          try {
            isGitRepo = fs.existsSync(gitPath);
          } catch {
            // ignore permission errors
          }
          return { name: entry.name, path: fullPath, isGitRepo };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      // Windows: enumerate available drive letters
      let drives: string[] = [];
      if (process.platform === 'win32') {
        for (let c = 65; c <= 90; c++) {
          const drive = `${String.fromCharCode(c)}:\\`;
          try {
            fs.accessSync(drive);
            drives.push(drive);
          } catch {
            // drive not available
          }
        }
      }

      return { current: dirPath, parent: path.dirname(dirPath), sep: path.sep, dirs, drives };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /validate?path=<dir>
   * 验证路径是否为有效 Git 仓库
   */
  app.get('/validate', async (request, reply) => {
    try {
      const { path: dirPath } = validateQuerySchema.parse(request.query);

      // 检查路径是否存在
      if (!fs.existsSync(dirPath)) {
        return { valid: false, path: dirPath, error: 'Path does not exist' };
      }

      // 检查是否是目录
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return { valid: false, path: dirPath, error: 'Path is not a directory' };
      }

      // 检查是否是 Git 仓库
      const gitPath = path.join(dirPath, '.git');
      if (!fs.existsSync(gitPath)) {
        return { valid: false, path: dirPath, error: 'Not a Git repository (no .git found)' };
      }

      return { valid: true, path: dirPath };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
