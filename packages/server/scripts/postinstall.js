/**
 * postinstall 脚本 - 修复 node-pty 原生模块权限问题
 *
 * 问题背景：
 * node-pty 是一个用于创建伪终端 (PTY) 的 Node.js 库，用于与 Claude Code、Gemini CLI 等 Agent 进行交互。
 * 在 macOS 上，pnpm 安装 node-pty 时，预编译的 spawn-helper 二进制文件可能会丢失执行权限，
 * 导致 "posix_spawnp failed" 错误。
 *
 * 解决方案：
 * 在 postinstall 阶段自动为 spawn-helper 添加执行权限。
 */

import { readdirSync, chmodSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 向上查找 monorepo 根目录（包含 pnpm-workspace.yaml 或根 node_modules）
 */
function findMonorepoRoot(startDir) {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    // 检查是否存在 pnpm-workspace.yaml（pnpm monorepo 标志）
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    // 检查是否存在 node_modules/.pnpm（pnpm 的依赖目录）
    if (existsSync(join(dir, 'node_modules', '.pnpm'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * 递归查找匹配的文件
 */
function findFiles(dir, pattern, results = [], depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return results;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过隐藏目录（除了 .pnpm）
        if (entry.name.startsWith('.') && entry.name !== '.pnpm') {
          continue;
        }
        findFiles(fullPath, pattern, results, depth + 1, maxDepth);
      } else if (pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch {
    // 忽略无法访问的目录
  }
  return results;
}

/**
 * 修复 spawn-helper 权限
 */
function fixSpawnHelperPermissions() {
  // 1. 优先查找包自身的 node_modules（npm 全局安装场景）
  const packageRoot = join(__dirname, '..');
  const localNodeModules = join(packageRoot, 'node_modules');

  // 2. 尝试查找 monorepo 根目录（pnpm monorepo 场景）
  const monorepoRoot = findMonorepoRoot(__dirname);
  const monorepoNodeModules = monorepoRoot ? join(monorepoRoot, 'node_modules') : null;

  // 收集所有需要搜索的 node_modules 目录（去重）
  const searchDirs = [];
  if (existsSync(localNodeModules)) {
    searchDirs.push(localNodeModules);
  }
  if (monorepoNodeModules && monorepoNodeModules !== localNodeModules && existsSync(monorepoNodeModules)) {
    searchDirs.push(monorepoNodeModules);
  }

  if (searchDirs.length === 0) {
    console.log('[postinstall] 未找到 node_modules 目录，跳过 spawn-helper 权限修复');
    return;
  }

  let fixed = 0;
  for (const nodeModulesDir of searchDirs) {
    console.log(`[postinstall] 在 ${nodeModulesDir} 中查找 spawn-helper...`);
    const spawnHelpers = findFiles(nodeModulesDir, /^spawn-helper$/);

    for (const file of spawnHelpers) {
      if (!file.includes('node-pty')) continue;

      try {
        const stats = statSync(file);
        const isExecutable = (stats.mode & 0o111) !== 0;

        if (!isExecutable) {
          chmodSync(file, 0o755);
          console.log(`[postinstall] 已修复 spawn-helper 权限: ${file}`);
          fixed++;
        }
      } catch (err) {
        console.warn(`[postinstall] 无法修复权限: ${file}`, err.message);
      }
    }
  }

  if (fixed > 0) {
    console.log(`[postinstall] 共修复 ${fixed} 个 spawn-helper 文件`);
  } else {
    console.log('[postinstall] 所有 spawn-helper 权限正常，无需修复');
  }
}

fixSpawnHelperPermissions();
