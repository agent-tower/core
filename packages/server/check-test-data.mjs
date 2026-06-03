import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const tasks = await prisma.task.findMany({
    where: {
      title: { contains: '[TEST]' }
    },
    include: {
      project: true,
      workspaces: true,
      teamRun: {
        include: {
          members: true,
          messages: {
            include: {
              participants: true
            }
          }
        }
      }
    }
  })
  
  console.log(JSON.stringify(tasks, null, 2))
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
