import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const project = await prisma.project.create({
    data: {
      name: '[E2E-UI-TEST] Private Message Display',
      description: 'Temporary test project for UI E2E private message verification',
      repoPath: '/tmp/test-repo-ui',
    },
  })

  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      title: '[TEST] Verify private message UI',
      status: 'IN_PROGRESS',
    },
  })

  const workspace = await prisma.workspace.create({
    data: {
      taskId: task.id,
      branchName: 'test-ui-private-msg',
      worktreePath: '/tmp/test-workspace-ui',
    },
  })

  const teamRun = await prisma.teamRun.create({
    data: {
      taskId: task.id,
      mainWorkspaceId: workspace.id,
      mode: 'TEAM',
    },
  })

  const memberA = await prisma.teamMember.create({
    data: {
      teamRunId: teamRun.id,
      name: 'Member-A',
      aliases: '[]',
      rolePrompt: 'Test member A',
      providerId: 'test-provider',
      capabilities: JSON.stringify({
        readRoom: true,
        postRoomMessage: true,
        mentionMembers: true,
        stopMemberWork: true,
        markReadyForReview: true,
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        readDiff: true,
        mergeWorkspace: true,
      }),
      workspacePolicy: 'shared',
      triggerPolicy: 'MENTION_ONLY',
      sessionPolicy: 'resume_last',
      queueManagementPolicy: 'own_only',
    },
  })

  const memberB = await prisma.teamMember.create({
    data: {
      teamRunId: teamRun.id,
      name: 'Member-B',
      aliases: '[]',
      rolePrompt: 'Test member B',
      providerId: 'test-provider',
      capabilities: JSON.stringify({
        readRoom: true,
        postRoomMessage: true,
        mentionMembers: true,
        stopMemberWork: false,
        markReadyForReview: false,
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        readDiff: true,
        mergeWorkspace: false,
      }),
      workspacePolicy: 'shared',
      triggerPolicy: 'MENTION_ONLY',
      sessionPolicy: 'new_per_request',
      queueManagementPolicy: 'own_only',
    },
  })

  const memberC = await prisma.teamMember.create({
    data: {
      teamRunId: teamRun.id,
      name: 'Member-C',
      aliases: '[]',
      rolePrompt: 'Test member C',
      providerId: 'test-provider',
      capabilities: JSON.stringify({
        readRoom: true,
        postRoomMessage: true,
        mentionMembers: false,
        stopMemberWork: false,
        markReadyForReview: false,
        readFiles: true,
        writeFiles: false,
        runCommands: true,
        readDiff: true,
        mergeWorkspace: false,
      }),
      workspacePolicy: 'shared',
      triggerPolicy: 'MENTION_ONLY',
      sessionPolicy: 'new_per_request',
      queueManagementPolicy: 'own_only',
    },
  })

  const publicMsg = await prisma.roomMessage.create({
    data: {
      teamRunId: teamRun.id,
      senderType: 'user',
      kind: 'chat',
      visibility: 'PUBLIC',
      content: '这是一条公开消息，所有人可见。',
      mentions: '[]',
    },
  })

  const privateMsg1 = await prisma.roomMessage.create({
    data: {
      teamRunId: teamRun.id,
      senderType: 'agent',
      senderId: memberA.id,
      kind: 'chat',
      visibility: 'PRIVATE',
      content: '[私聊] Member-A 发给 Member-B 的私密消息。',
      mentions: '[]',
    },
  })

  await prisma.roomMessageParticipant.createMany({
    data: [
      { teamRunId: teamRun.id, roomMessageId: privateMsg1.id, memberId: memberA.id, role: 'SENDER' },
      { teamRunId: teamRun.id, roomMessageId: privateMsg1.id, memberId: memberB.id, role: 'RECIPIENT' },
    ],
  })

  const privateMsg2 = await prisma.roomMessage.create({
    data: {
      teamRunId: teamRun.id,
      senderType: 'agent',
      senderId: memberA.id,
      kind: 'chat',
      visibility: 'PRIVATE',
      content: '[私聊] Member-A 发给 Member-B 和 Member-C 的群组私聊。',
      mentions: '[]',
    },
  })

  await prisma.roomMessageParticipant.createMany({
    data: [
      { teamRunId: teamRun.id, roomMessageId: privateMsg2.id, memberId: memberA.id, role: 'SENDER' },
      { teamRunId: teamRun.id, roomMessageId: privateMsg2.id, memberId: memberB.id, role: 'RECIPIENT' },
      { teamRunId: teamRun.id, roomMessageId: privateMsg2.id, memberId: memberC.id, role: 'RECIPIENT' },
    ],
  })

  console.log(JSON.stringify({
    projectId: project.id,
    taskId: task.id,
    workspaceId: workspace.id,
    teamRunId: teamRun.id,
    memberA: { id: memberA.id, name: memberA.name },
    memberB: { id: memberB.id, name: memberB.name },
    memberC: { id: memberC.id, name: memberC.name },
    publicMsgId: publicMsg.id,
    privateMsg1Id: privateMsg1.id,
    privateMsg2Id: privateMsg2.id,
  }, null, 2))
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
