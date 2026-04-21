import fs from 'node:fs';
import path from 'node:path';

/**
 * 将项目配置的文件从主仓库复制到 worktree
 *
 * copyFilesConfig 格式：逗号分隔的路径/glob 模式
 * 例如: ".env, node_modules, .prisma, dist/**"
 */
export function copyProjectFiles(
  repoPath: string,
  worktreePath: string,
  copyFilesConfig: string,
): void {
  const patterns = copyFilesConfig
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const pattern of patterns) {
    // 安全检查：拒绝路径穿越
    if (pattern.includes('..')) {
      console.warn(`[CopyFiles] Skipping pattern with path traversal: ${pattern}`);
      continue;
    }

    const sourcePath = path.join(repoPath, pattern);

    try {
      const stat = fs.statSync(sourcePath);

      if (stat.isDirectory()) {
        // 目录：递归复制
        copyDir(sourcePath, path.join(worktreePath, pattern));
      } else {
        // 具体文件：直接复制
        copyFile(sourcePath, path.join(worktreePath, pattern));
      }
    } catch {
      // 不存在的具体路径，当作 glob 模式处理
      copyByGlob(repoPath, worktreePath, pattern);
    }
  }
}

function copyFile(src: string, dest: string): void {
  if (fs.existsSync(dest)) return; // 幂等：跳过已存在
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src: string, dest: string): void {
  if (fs.existsSync(dest)) return; // 幂等：跳过已存在
  fs.cpSync(src, dest, { recursive: true });
}

function copyByGlob(repoPath: string, worktreePath: string, pattern: string): void {
  try {
    // Node 22 实验性 API，TypeScript 类型定义尚未包含
    const globSync = (fs as any).globSync as
      | ((pattern: string, options: { cwd: string }) => string[])
      | undefined;

    if (!globSync) {
      console.warn(`[CopyFiles] fs.globSync not available, skipping glob pattern: ${pattern}`);
      return;
    }

    const matches: string[] = globSync(pattern, { cwd: repoPath });
    for (const match of matches) {
      const src = path.join(repoPath, match);
      const dest = path.join(worktreePath, match);

      // 安全检查：确保目标在 worktree 内
      const rel = path.relative(path.resolve(worktreePath), path.resolve(dest));
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        console.warn(`[CopyFiles] Skipping file outside worktree: ${match}`);
        continue;
      }

      if (fs.existsSync(dest)) continue;

      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
  } catch (err) {
    console.warn(`[CopyFiles] Glob pattern "${pattern}" failed:`, err);
  }
}
