# Agent Tower Desktop

Electron desktop shell for running the existing Agent Tower Web UI with the Node/Fastify backend as a local child process.

The packaged desktop app is named `Agent Tower`. Installer generation is configured for macOS, Windows, and Linux. Code signing, notarization, and auto-update are still release-hardening work.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter @agent-tower/desktop spike
```

The `spike` script builds `shared`, `server`, `web`, and `desktop`, then starts Electron.

The desktop package currently pins Electron `33.4.11`, which keeps the dev dependency compatible with the repository's Node `>=18` baseline. The workspace `onlyBuiltDependencies` config allows Electron's install script so the local Electron binary can be downloaded during `pnpm install`.

To verify the Electron binary is available:

```bash
pnpm --filter @agent-tower/desktop exec electron --version
```

For terminal-path verification, enable the optional smoke check:

```bash
AGENT_TOWER_DESKTOP_VERIFY_SOCKET=1 AGENT_TOWER_DESKTOP_VERIFY_TERMINAL=1 pnpm --filter @agent-tower/desktop spike
```

PowerShell:

```powershell
$env:AGENT_TOWER_DESKTOP_VERIFY_SOCKET="1"; $env:AGENT_TOWER_DESKTOP_VERIFY_TERMINAL="1"; pnpm --filter @agent-tower/desktop spike
```

## Self-Contained Packages

Build the current-platform unpacked desktop app:

```bash
pnpm desktop:package:dir
```

Build installer packages:

```bash
pnpm --filter @agent-tower/desktop package:mac
pnpm --filter @agent-tower/desktop package:win
pnpm --filter @agent-tower/desktop package:linux
```

This produces `packages/desktop/release/<platform>-<arch>/` and includes:

- Electron desktop shell (`packages/desktop/dist`).
- Server runtime staged under `Contents/Resources/runtime/server` on macOS, or the equivalent `resources/runtime/server` directory on Windows/Linux.
- Web static assets staged under `resources/runtime/web`.
- Server production dependencies from `pnpm --filter @agent-tower/server deploy --legacy --prod`, including Prisma, generated Prisma client/engines, node-pty prebuilds, and cloudflared.

Run the packaged smoke check:

```bash
pnpm desktop:package:smoke
```

The smoke check starts the unpacked app, verifies `/api/health`, connects Socket.IO `/events`, creates/deletes one standalone terminal through the HTTP API, waits for the Web UI to load, then terminates the app.

For manual packaged-app acceptance, use the isolated launcher:

```bash
pnpm desktop:package:acceptance
```

This starts the unpacked packaged app binary with a temporary `HOME`, temporary Electron `userData`, `AGENT_TOWER_DESKTOP_DATA_MODE=isolated`, and `AGENT_TOWER_DATA_DIR=<temp userData>/data`. The command prints the exact temp directories before launching and removes them after the app exits.

Isolated acceptance and smoke launches set `AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS=120000` by default so first-run SQLite/Prisma initialization in a fresh temporary data directory can finish before the desktop health check times out. The packaged smoke script waits for that startup budget plus an extra 30 seconds by default, and `AGENT_TOWER_DESKTOP_SMOKE_TIMEOUT_MS` can override the outer smoke timeout when needed.

Do not use `open packages/desktop/release/.../Agent Tower.app` for tests or acceptance runs. Directly opening the packaged app intentionally uses the production default data policy and can connect to the standard `~/.agent-tower` data directory. Only direct-open the app when explicitly validating the formal shared-data behavior.

Packaged mode does not use a global `agent-tower` command. The desktop app starts `runtime/server/dist/cli.js` directly from app resources. Windows packages use the bundled `runtime/node/node.exe` for the backend and agent wrapper processes; other packaged platforms currently keep using Electron's executable as a Node-compatible runtime with `ELECTRON_RUN_AS_NODE=1`.

## Integrated Titlebar

On macOS and Windows the desktop shell uses an integrated titlebar: Electron hides the separate system title text and lets the Web app header act as the draggable titlebar. macOS keeps the red/yellow/green window controls with left header padding for the traffic lights. Windows uses Electron's Window Controls Overlay so the native minimize/maximize/close buttons sit over the header, with right header padding to avoid interactive controls under the overlay. Normal browser usage does not get the extra padding or desktop drag styling.

## MCP Client Config

The desktop app exposes a minimal MCP configuration entry in the app:

```text
Settings -> MCP Config
```

Copy the JSON from that screen into an MCP-capable client. The generated config uses the `agent-tower` MCP server name.

In packaged desktop mode, the config points at the bundled runtime:

- `command`: the bundled runtime command. On Windows this is `resources/runtime/node/node.exe`; on other packaged platforms this is the packaged Electron app executable.
- `args`: `resources/runtime/server/dist/mcp/index.js` inside the app resources.
- `env.ELECTRON_RUN_AS_NODE`: `1` only when the command is the Electron app executable.
- `env.AGENT_TOWER_DATA_DIR`: the data directory used by the current desktop backend, so the MCP process can discover the current backend port file.

This means users do not need `npm i -g agent-tower` or a global `agent-tower-mcp` command for the packaged desktop MCP path.

In development mode, the same screen points at the workspace `packages/server/dist/mcp/index.js` and the current Node runtime. Run the normal desktop build first so the server dist exists:

```bash
pnpm --filter @agent-tower/desktop spike
```

The current version only displays and copies generic MCP JSON. It does not automatically edit Claude, Codex, Cursor, or other third-party client configuration files.

## What It Does

- Development mode starts `packages/server/dist/cli.js` from the workspace.
- Packaged mode starts the bundled `runtime/server/dist/cli.js` from app resources.
- Binds the backend to `127.0.0.1` on an available random port.
- Stores development data under Electron `app.getPath('userData')/data`.
- In packaged desktop mode, does not override `--data-dir`; the server CLI uses the standard Agent Tower user data directory, matching `agent-tower` npm/CLI startup.
- Test and acceptance packaged launches must use `pnpm desktop:package:smoke` or `pnpm desktop:package:acceptance`, both of which force temporary isolated data directories.
- Points `AGENT_TOWER_WEB_DIR` at workspace `packages/web/dist` in development and bundled `runtime/web` in packaged mode.
- Waits for `/api/health`, then loads the existing Web UI in a `BrowserWindow`. The default backend startup timeout is 90 seconds and can be overridden with `AGENT_TOWER_DESKTOP_STARTUP_TIMEOUT_MS`.
- Logs a rough memory snapshot for Electron processes and the Node backend.
- Optionally verifies Socket.IO when `AGENT_TOWER_DESKTOP_VERIFY_SOCKET=1`.
- Optionally creates and deletes one standalone terminal when `AGENT_TOWER_DESKTOP_VERIFY_TERMINAL=1`.
- Exposes `/api/system/mcp-config` for the Web UI to display/copy MCP client configuration.

## Data Directory Policy

Desktop data mode is selected by `AGENT_TOWER_DESKTOP_DATA_MODE` when set; otherwise it follows the Electron runtime:

- `isolated`: used by default for development runs (`app.isPackaged === false`). The backend receives `--data-dir <Electron userData>/data`, so desktop tests do not pollute the real CLI data.
- `shared`: used by default for packaged desktop runs (`app.isPackaged === true`). The desktop process does not pass `--data-dir` or set a desktop-specific `AGENT_TOWER_DATA_DIR`, so `packages/server/src/cli.ts` owns the data directory contract: an explicitly provided `AGENT_TOWER_DATA_DIR` still works, otherwise it uses the same standard directory as `agent-tower` npm/CLI startup (`~/.agent-tower` unless the CLI contract changes).

To simulate the packaged/shared data strategy without creating an installer:

```bash
AGENT_TOWER_DESKTOP_DATA_MODE=shared pnpm --filter @agent-tower/desktop start
```

PowerShell:

```powershell
$env:AGENT_TOWER_DESKTOP_DATA_MODE="shared"; pnpm --filter @agent-tower/desktop start
```

Before a production desktop release, add process locking and version/migration checks around the shared SQLite data directory so the npm/CLI server and desktop server cannot both write incompatible state.

## Useful Commands

```bash
pnpm --filter @agent-tower/desktop build
pnpm --filter @agent-tower/desktop runtime:prepare
pnpm --filter @agent-tower/desktop package:dir
pnpm --filter @agent-tower/desktop package:mac
pnpm --filter @agent-tower/desktop package:win
pnpm --filter @agent-tower/desktop package:linux
pnpm --filter @agent-tower/desktop package:acceptance
pnpm --filter @agent-tower/desktop package:smoke
pnpm --filter @agent-tower/desktop start
```

`start` expects `packages/server/dist`, `packages/web/dist`, and `packages/desktop/dist` to already exist.

## GitHub Release Builds

`.github/workflows/build-desktop.yml` builds desktop packages on tag pushes matching `v*` and can also be started manually. The workflow uses hosted `macos-latest`, `windows-latest`, and `ubuntu-latest` runners, builds each platform natively, uploads build artifacts, and publishes tag builds to GitHub Releases through electron-builder using `GITHUB_TOKEN`.

Configured release outputs:

- macOS arm64: DMG.
- Windows x64: NSIS installer and portable executable.
- Linux x64: AppImage and deb package.

The workflow sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, so unsigned test packages can be produced without local signing credentials. Production distribution still needs macOS Developer ID signing/notarization and Windows code signing.

## Current Limits

- Development `spike` still uses `node` from `PATH`; packaged `package:dir` uses a bundled Node runtime on Windows and Electron node-mode elsewhere, so it does not require global `agent-tower`.
- Installer packages are generated, but signing/notarization is not configured yet.
- Does not implement auto-update.
- Does not add desktop-specific local API authentication yet.
- MCP config UI only displays and copies generic JSON; it does not write third-party client config files.
- macOS validation currently covers local arm64 app output. Windows/Linux package output still needs native GitHub runner verification, especially node-pty prebuild selection, executable permissions, Prisma engines, and cloudflared binary availability.
- Terminal smoke verification checks PTY creation/deletion through the HTTP API; full interactive terminal behavior is still validated through the loaded Web UI.
