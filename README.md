**English** | [简体中文](./README.zh-CN.md)

# Agent Tower

> Too many terminal sessions (Claude Code / Codex ...) open? Here's their command center.

## Why I Built This

When I first started using Claude Code, I'd open one terminal and sit there, bored, watching it spit out characters. Then I got clever — opened multiple terminals, ran different tasks at the same time, even worked on different projects simultaneously. Productivity went through the roof. I felt like an absolute genius.

That lasted about two days before the problems hit:

- **Visual chaos**: My desktop was covered in Claude Code terminals. I constantly lost track of which window was running which task.
- **Edit conflicts**: Multiple tasks touching the same files meant merge conflicts everywhere. I tried Git Worktree to isolate each task, but manually running commands to split, rebase, and merge was still a pain.
- **No mobile access**: Sitting in front of the computer staring at terminals gets old. When I'm chilling on the balcony with my phone, why can't I check on how my AI workhorses are doing?
- **Token bills**: More tasks meant bigger bills, and it stung. Plenty of simple tasks could run on cheaper models, but manually switching configs was a hassle — even with tools like ccswitch, you have to wait for the current task to finish before switching.

So Agent Tower was born out of necessity — a single dashboard that brings all your agent tasks, terminals, and code changes into one interface. Auto-creates isolated branches, lets you pick providers per task, works from your phone, and notifies you when it's time to review.

## Core Features

### 🎯 One Dashboard for All Agents

No more juggling terminal windows. All projects, all tasks, all agents — one page. Create a task, pick an agent, hit start — output, progress, and code changes are visible in real time. When a task finishes, it automatically moves to "Ready for Review". You decide whether to merge.

### 🔀 Automatic Git Worktree Isolation

Each task gets its own Git branch automatically. Agents work in isolated environments, eliminating code conflicts at the root. One-click merge back to main, with line-by-line review in the diff viewer.

### 💰 Pick Providers Per Task, Save Money Effortlessly

Each task can use a different provider. Throw translation tasks to MiniMax, planning to Opus, execution to Codex — each in their lane, no waiting for one task to finish before switching. Agent Tower helps you spend smart.

### 📱 Monitor Progress from Your Phone

One-click Cloudflare tunnel for remote access — open the dashboard right in your phone's browser. Away from your desk? Still in the loop. Task done? Desktop notification or Lark webhook lets you know it's review time.

### 🤖 Supports Major AI Agents

- **Claude Code** · **Gemini CLI** · **Cursor Agent** · **Codex**

No vendor lock-in. Use whichever agent you prefer. Each supports custom Profile variants.

### 📡 MCP Protocol Integration

Built-in MCP server lets agents read the task board, claim tasks, and report progress directly. You're not just managing agents — they can collaborate proactively.

## Getting Started

**Recommended: global install** (simplest — one command and you're done)

```bash
npm install -g agent-tower
agent-tower
```

Open `http://localhost:12580` and start using it.

> Prerequisite: Node.js >= 18

### Configure MCP (Optional)

Let Claude Code operate the task board directly:

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp",
      "args": []
    }
  }
}
```

### Development from Source

```bash
git clone https://github.com/nicepkg/agent-tower.git
cd agent-tower
pnpm setup          # Install deps + build shared package
pnpm dev            # Start all services in dev mode
```

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                  Browser (React)                 │
│  Kanban ─ Terminal ─ Code Editor ─ Git Changes   │
│  TanStack Query (server cache) + Zustand (UI)   │
└──────────────────┬──────────────────────────────┘
                   │ HTTP REST + Socket.IO (/events)
┌──────────────────┴──────────────────────────────┐
│                Fastify Server                    │
│  ┌───────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ REST API  │ │ Socket.IO│ │  MCP Server    │  │
│  │ (16 routes)│ │ (realtime)│ │ (agent integ.) │  │
│  └─────┬─────┘ └────┬─────┘ └───────┬────────┘  │
│        └──────┬──────┘               │           │
│        ┌──────┴──────┐               │           │
│        │  Services   │               │           │
│        │ Session Mgmt│               │           │
│        │ Workspace   │               │           │
│        │ Git/Worktree│               │           │
│        │ Notif/Tunnel│               │           │
│        └──────┬──────┘               │           │
│        ┌──────┴──────┐               │           │
│        │AgentPipeline│               │           │
│        │ PTY + Parser│               │           │
│        │ + MsgStore  │               │           │
│        └──────┬──────┘               │           │
│               │ node-pty             │           │
│        ┌──────┴──────┐               │           │
│        │  Executors  │               │           │
│        │ Claude Code │               │           │
│        │ Gemini CLI  │               │           │
│        │ Cursor Agent│               │           │
│        │ Codex       │               │           │
│        └─────────────┘               │           │
│                                      │           │
│        ┌─────────────┐               │           │
│        │ SQLite      │◄──────────────┘           │
│        │ (Prisma ORM)│                           │
│        └─────────────┘                           │
└─────────────────────────────────────────────────┘
```

### Design Philosophy

**Agents as Team Members**: Agent Tower treats AI agents like team members. Projects are workspaces, tasks are work items, agents are executors. Manage assignments via the kanban board, monitor execution through terminals, review results through Git integration.

**Pipeline Architecture**: Each agent session is managed by an AgentPipeline with three core components:
- **PTY**: Pseudo-terminal for interacting with the agent CLI process
- **Parser**: Output parser that structures raw agent output into tool calls, code changes, etc.
- **MsgStore**: Message store using JSON Patch for incremental sync to the frontend

**Worktree Isolation**: Each task creates an independent Git Worktree, so agents work on isolated branches — preventing conflicts when multiple agents modify code simultaneously.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite 7 + TypeScript 5 |
| Styling | TailwindCSS v4 + shadcn/ui (Radix UI) |
| State | TanStack Query v5 + Zustand v5 |
| Terminal | xterm.js 5 + Monaco Editor |
| Backend | Fastify 4 + Socket.IO 4 |
| Database | Prisma 5 + SQLite |
| Process | node-pty |
| Protocol | MCP (Model Context Protocol) |
| Package | pnpm monorepo |

## License

<!-- TODO: License to be determined -->
