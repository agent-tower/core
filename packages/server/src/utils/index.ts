import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function execAsync(
  command: string
): Promise<{ stdout: string; stderr: string }> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execPromise = promisify(exec);
  return execPromise(command);
}
