import { prisma } from '../utils/index.js';

/** Matches GET /git/changes when multiple workspace records share a directory. */
export async function resolveWorkspaceGitTarget(workingDir: string): Promise<{ baseBranch: string; repositoryPath: string } | null> {
  const workspace = await prisma.workspace.findFirst({
    where: { OR: [{ workingDir }, { worktreePath: workingDir }] },
    include: { task: { include: { project: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  if (!workspace) return null;
  return { baseBranch: workspace.baseBranch || workspace.task.project.mainBranch, repositoryPath: workspace.task.project.repoPath };
}
