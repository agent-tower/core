# Built-server workspace Git push smoke

This smoke run uses a real Socket.IO client, real Git repositories, the built
server, and an isolated SQLite database. It never starts a server from the test
process. Start and stop the server with the Agent Tower workspace service MCP.
No additional packages are needed: the scripts use the existing server Prisma
client and the web package's `socket.io-client` installation.

## Preparation

From the repository root, complete the normal shared/server builds and Prisma
client generation first. Keep heavy build and test commands sequential on the
production host. The default scratch directory is
`.tmp-step3a/workspace-git-push`, entirely inside this worktree. The default port
is **18483**. An explicit root can also be a child of a private, user-owned
`TMPDIR` under `/tmp`. Port 12580 is reserved for production.

To exercise replacement, start the smoke server with
`AGENT_TOWER_COMMAND_HELPER_RECYCLE_RSS_MB=1` and pass `--expect-recycle` to
`run.mjs`. Start the client promptly so it subscribes before the third 30-second
sample. Allow 150 seconds for the run. The report includes both helper PIDs,
the two epochs, and the first external commit pushed by the replacement.

Start a workspace service with these structured arguments:

```json
{
  "service_name": "workspace-git-push-smoke",
  "command": "node",
  "args": [
    "scripts/acceptance/workspace-git-push/start-server.mjs",
    "--port=18483",
    "--root=.tmp-step3a/workspace-git-push",
    "--helper=on"
  ],
  "relative_cwd": "."
}
```

The wrapper is the server process: it imports `packages/server/dist/cli.js`
without spawning another server. It sets an isolated HOME, temporary directory,
and data directory before importing the CLI, binds only `127.0.0.1`, and disables
access-password authentication only in that disposable database. Use bounded
`get_workspace_service_logs` calls to confirm the ready message.

## Finite verification

Once the service is ready, run this bounded command in the normal terminal:

```bash
timeout 90 node scripts/acceptance/workspace-git-push/run.mjs \
  --port=18483 --root=.tmp-step3a/workspace-git-push
```

The run creates one linked WORKTREE workspace and two MAIN_DIRECTORY workspace
IDs sharing the main repository directory. It seeds only its own disposable
project/task/workspace records through Prisma, and verifies the public socket
and REST behavior against the separate server. The socket uses the browser-owner
path without internal or agent headers; the isolated server has its access
password disabled. HTTP requests use only that isolated instance's internal token:

- The subscribe acknowledgement matches the current Git HEAD and both REST
  response shapes.
- A plain `git commit` outside Tower causes a push with the new HEAD and a higher
  version in the same epoch.
- REST reads of the registered, clean linked worktree start zero additional Git
  processes.
- The two main-directory IDs share one registration and receive matching state
  versions. Their status retains the existing static main-directory REST shape
  even when their changes response contains a modified file.
- Unsubscribing one main-directory ID and waiting beyond the 10-second grace
  leaves the other ID subscribed and receiving changes.
- Disconnecting the socket releases all registrations after the grace before
  removing the fixture and its database records.

`report.json` contains the result, commit-to-push latency, helper PID/RSS,
process counters, and final registration count. The wrapper writes
`observation.json` using acceptance-only instrumentation in its own process;
this adds no application endpoint. Each smoke wait and Git command is bounded.
A failed teardown retains the fixture rather than deleting a watched directory.
The normal run lasts approximately 25–35 seconds because it observes both grace
periods. It does not claim that idle dirty worktrees cost one Git process: the
approved step 2 computation uses `status` plus numstat when tracked edits remain.

## Shutdown

Always stop the service after the finite script finishes, including failures:

```json
{"service_name":"workspace-git-push-smoke","action":"stop"}
```

Read the final `observation.json`: `stopped` should be true, the helper should be
stopped, and `serverWatchHandles` should be zero. Confirm that the recorded server
and helper PIDs have exited using a read-only process check. Do not signal any
other process. The script does not stop or alter the production Agent Tower
service.

For the in-process placement, start a fresh scratch directory/service with
`--helper=off`, then run the same finite script against its port and directory.
The server is intentionally left under workspace-service ownership until the
explicit MCP stop call.
