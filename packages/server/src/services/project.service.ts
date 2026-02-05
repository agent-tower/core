import { prisma } from '../utils/index.js';

interface CreateProjectInput {
  name: string;
  description?: string;
  repoPath: string;
  mainBranch?: string;
}

interface UpdateProjectInput {
  name?: string;
  description?: string;
  mainBranch?: string;
}

export class ProjectService {
  async findAll() {
    return prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    return prisma.project.findUnique({
      where: { id },
      include: { tasks: true },
    });
  }

  async create(input: CreateProjectInput) {
    return prisma.project.create({
      data: {
        name: input.name,
        description: input.description,
        repoPath: input.repoPath,
        mainBranch: input.mainBranch || 'main',
      },
    });
  }

  async update(id: string, input: UpdateProjectInput) {
    try {
      return await prisma.project.update({
        where: { id },
        data: input,
      });
    } catch {
      return null;
    }
  }

  async delete(id: string) {
    try {
      await prisma.project.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
