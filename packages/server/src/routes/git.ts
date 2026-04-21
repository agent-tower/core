import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { prisma } from '../utils/index.js';

function handleError(error: unknown, reply: any) {
  if (error instanceof ZodError) {
    reply.code(400);
    return { error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors };
  }

  console.error('[git] Unhandled error:', error);
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

/** execFile promisified with timeout */
function execGit(cwd: string, args: string[]): Promise<string> {
  const isWindows = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      ...(isWindows ? { shell: true } : {}),
    }, (err, stdout) => {
      if (err) {
        if (stdout !== undefined && stdout !== '') {
          resolve(stdout);
          return;
        }
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

type ChangeEntry = { status: string; path: string };

async function resolveBaseBranch(workingDir: string): Promise<string | null> {
  const workspace = await prisma.workspace.findFirst({
    where: { worktreePath: workingDir },
    include: { task: { include: { project: true } } },
    orderBy: { updatedAt: 'desc' },
  });

  if (!workspace) {
    return null;
  }

  return workspace.baseBranch || workspace.task.project.mainBranch;
}

function getRemoteBranchRef(branch: string): string {
  return branch.startsWith('origin/') ? branch : `origin/${branch}`;
}

function parseNameStatus(output: string): ChangeEntry[] {
  if (!output.trim()) return [];
  return output
    .trim()
    .split('\n')
    .map((line) => {
      // Format: "M\tpath" or "R100\told\tnew"
      const parts = line.split('\t');
      if (parts.length < 2) return null;
      const rawStatus = parts[0]!;
      // Normalize rename status (R100 -> R)
      const status = rawStatus.startsWith('R') ? 'R' : rawStatus;
      const filePath = parts.length >= 3 ? parts[2]! : parts[1]!;
      return { status, path: filePath };
    })
    .filter((entry): entry is ChangeEntry => entry !== null);
}

const workingDirSchema = z
  .string()
  .min(1, 'workingDir is required')
  .refine((v) => path.isAbsolute(v), { message: 'workingDir must be absolute' })
  .refine((v) => !v.split(path.sep).includes('..'), {
    message: 'Path traversal (..) is not allowed',
  });

const changesQuerySchema = z.object({
  workingDir: workingDirSchema,
});

const diffQuerySchema = z.object({
  workingDir: workingDirSchema,
  path: z
    .string()
    .min(1, 'path is required')
    .refine((v) => !v.split('/').includes('..'), {
      message: 'Path traversal (..) is not allowed',
    }),
  type: z.enum(['uncommitted', 'committed']),
});

const logQuerySchema = z.object({
  workingDir: workingDirSchema,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

const commitFilesQuerySchema = z.object({
  workingDir: workingDirSchema,
  hash: z.string().regex(/^[0-9a-f]{4,40}$/i, 'Invalid commit hash'),
});

const commitDiffQuerySchema = z.object({
  workingDir: workingDirSchema,
  hash: z.string().regex(/^[0-9a-f]{4,40}$/i, 'Invalid commit hash'),
  path: z
    .string()
    .min(1, 'path is required')
    .refine((v) => !v.split('/').includes('..'), {
      message: 'Path traversal (..) is not allowed',
    }),
});

export async function gitRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    return handleError(error, reply);
  });

  /**
   * GET /changes?workingDir=/path/to/worktree
   * Returns uncommitted changes vs HEAD and committed changes vs workspace base branch.
   */
  app.get('/changes', async (request, reply) => {
    try {
      const { workingDir } = changesQuerySchema.parse(request.query);
      const baseBranch = await resolveBaseBranch(workingDir);

      // Uncommitted changes (staged + unstaged vs HEAD)
      let uncommitted: ChangeEntry[] = [];
      try {
        const output = await execGit(workingDir, ['diff', '--name-status', 'HEAD']);
        uncommitted = parseNameStatus(output);
      } catch {
        // If HEAD doesn't exist (initial commit), try against empty tree
        try {
          const output = await execGit(workingDir, ['diff', '--name-status']);
          uncommitted = parseNameStatus(output);
        } catch {
          // ignore
        }
      }

      // Also include untracked files
      try {
        const untrackedOutput = await execGit(workingDir, [
          'ls-files', '--others', '--exclude-standard',
        ]);
        if (untrackedOutput.trim()) {
          const untrackedFiles = untrackedOutput.trim().split('\n');
          for (const f of untrackedFiles) {
            uncommitted.push({ status: 'A', path: f });
          }
        }
      } catch {
        // ignore
      }

      // Committed changes (baseBranch...HEAD)
      const committedBaseBranch = baseBranch || 'main';
      let committed: ChangeEntry[] = [];
      try {
        const output = await execGit(workingDir, [
          'diff',
          '--name-status',
          `${committedBaseBranch}...HEAD`,
        ]);
        committed = parseNameStatus(output);
      } catch {
        try {
          const output = await execGit(workingDir, [
            'diff',
            '--name-status',
            `${getRemoteBranchRef(committedBaseBranch)}...HEAD`,
          ]);
          committed = parseNameStatus(output);
        } catch {
          // ignore — no base branch to compare against
        }
      }

      return { uncommitted, committed };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /diff?workingDir=/path&path=src/index.ts&type=uncommitted|committed
   * Returns the diff content for a single file.
   */
  app.get('/diff', async (request, reply) => {
    try {
      const { workingDir, path: filePath, type } = diffQuerySchema.parse(request.query);
      const baseBranch = type === 'committed' ? await resolveBaseBranch(workingDir) : null;

      const committedBaseBranch = baseBranch || 'main';
      let diff = '';
      try {
        if (type === 'uncommitted') {
          diff = await execGit(workingDir, ['diff', '--', filePath]);
          // If no staged/unstaged diff, the file might be untracked — show full content as addition
          if (!diff.trim()) {
            diff = await execGit(workingDir, ['diff', '--no-index', '/dev/null', filePath]).catch(
              () => '',
            );
          }
        } else {
          diff = await execGit(workingDir, ['diff', `${committedBaseBranch}...HEAD`, '--', filePath]);
          if (!diff.trim()) {
            diff = await execGit(
              workingDir,
              ['diff', `${getRemoteBranchRef(committedBaseBranch)}...HEAD`, '--', filePath]
            ).catch(() => '');
          }
        }
      } catch {
        // ignore — return empty diff
      }

      return { diff };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /log?workingDir=/path&limit=50&skip=0
   * Returns commit history of the current branch.
   */
  app.get('/log', async (request, reply) => {
    try {
      const { workingDir, limit, skip } = logQuerySchema.parse(request.query);

      // NUL (\x00) as field separator; %x01 as record separator (body may contain newlines)
      const format = '%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x01';
      const args = ['log', `--format=${format}`, `--max-count=${limit}`, `--skip=${skip}`, 'HEAD'];

      let output = '';
      try {
        output = await execGit(workingDir, args);
      } catch {
        // HEAD might not exist (empty repo)
        return { commits: [] };
      }

      const commits = output
        .split('\x01')
        .map((rec) => rec.trim())
        .filter((rec) => rec.length > 0)
        .map((rec) => {
          const parts = rec.split('\0');
          const [hash, shortHash, author, email, timestamp, subject] = parts;
          // body is everything after the 6th field, joined back (in case body itself contained \0)
          const body = (parts.slice(6).join('\0') || '').trim();
          return {
            hash: hash || '',
            shortHash: shortHash || '',
            author: author || '',
            email: email || '',
            timestamp: Number(timestamp || 0),
            message: subject || '',
            body,
          };
        });

      return { commits };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /commit-files?workingDir=/path&hash=abc123
   * Returns the list of files changed in a specific commit.
   */
  app.get('/commit-files', async (request, reply) => {
    try {
      const { workingDir, hash } = commitFilesQuerySchema.parse(request.query);

      let files: ChangeEntry[] = [];
      try {
        const output = await execGit(workingDir, ['diff-tree', '--no-commit-id', '--name-status', '-r', hash]);
        files = parseNameStatus(output);
      } catch {
        // ignore
      }

      return { files };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  /**
   * GET /commit-diff?workingDir=/path&hash=abc123&path=src/index.ts
   * Returns the diff of a specific file in a specific commit.
   */
  app.get('/commit-diff', async (request, reply) => {
    try {
      const { workingDir, hash, path: filePath } = commitDiffQuerySchema.parse(request.query);

      let diff = '';
      try {
        // git show --format= shows only the diff portion, no commit header
        diff = await execGit(workingDir, ['show', '--format=', hash, '--', filePath]);
      } catch {
        // ignore
      }

      return { diff };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
