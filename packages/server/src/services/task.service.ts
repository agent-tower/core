import { prisma } from '../utils/index.js';
import { TaskStatus } from '../types/index.js';

interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: number;
}

interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: number;
}

export class TaskService {
  async findByProjectId(projectId: string) {
    return prisma.task.findMany({
      where: { projectId },
      include: { workspaces: true },
      orderBy: [{ status: 'asc' }, { position: 'asc' }],
    });
  }

  async findById(id: string) {
    return prisma.task.findUnique({
      where: { id },
      include: { workspaces: { include: { sessions: true } } },
    });
  }

  async create(projectId: string, input: CreateTaskInput) {
    const maxPosition = await prisma.task.aggregate({
      where: { projectId, status: TaskStatus.TODO },
      _max: { position: true },
    });

    return prisma.task.create({
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority || 0,
        position: (maxPosition._max.position || 0) + 1,
        projectId,
      },
    });
  }

  async update(id: string, input: UpdateTaskInput) {
    try {
      return await prisma.task.update({
        where: { id },
        data: input,
      });
    } catch {
      return null;
    }
  }

  async updateStatus(id: string, status: TaskStatus) {
    try {
      return await prisma.task.update({
        where: { id },
        data: { status },
      });
    } catch {
      return null;
    }
  }

  async updatePosition(id: string, position: number, status?: TaskStatus) {
    try {
      return await prisma.task.update({
        where: { id },
        data: { position, ...(status && { status }) },
      });
    } catch {
      return null;
    }
  }

  async delete(id: string) {
    try {
      await prisma.task.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}
