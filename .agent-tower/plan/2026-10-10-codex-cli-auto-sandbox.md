# Codex CLI AUTO_SANDBOX implementation record

- Scope: Codex CLI native "Approve for me" only. Claude and ACP native adapters and the existing FULL_ACCESS exec path are unchanged. The shared Codex policy boundary also applies to ACP AUTO_SANDBOX so a restricted subject cannot bypass it by switching runtimes.
- Verified host/build: Darwin arm64, Codex CLI 0.161.0, native SHA256 `12ac11d2c7eee27cfae34393986d7b7c9ed0dea537cb749831cdd7033893e6de`.
- Official semantics: [OpenAI Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review), [App-server approvals](https://learn.chatgpt.com/docs/app-server#approvals). The reviewer changes; the workspace sandbox remains in place. Native review can approve crossing that sandbox boundary.

## Implementation

CLI ASK and AUTO_SANDBOX use the existing owned app-server stdio process, a fresh process for each turn, and native `thread/resume` for follow-ups. The executor projects `approval_policy=on-request`, `sandbox_mode=workspace-write`, and the selected `approvals_reviewer`. After `initialize`, both `thread/start` and `thread/resume` must positively return the same policy, reviewer, and `workspaceWrite` sandbox before `turn/start` is sent. A failed confirmation ends the launch without falling back to ASK or FULL_ACCESS. Remaining native command/file requests retain the current human approval card and delivery-time authorization checks; other native interaction types remain separate and fail explicitly.

Review repair: CLI AUTO rejects Provider TOML containing `sandbox_workspace_write`, including nested profiles. It emits final `-c sandbox_workspace_write.writable_roots=[]` and `network_access=false` overrides to contain inherited native configuration. Both new and resumed native thread responses must report empty extra writable roots and disabled network access before `turn/start`; missing or wider values fail closed. The capability draft includes current advanced TOML, and save/test/import/start share the conflict diagnostic. On the verified native build, resuming a FULL_ACCESS thread with hostile inherited sandbox settings may return a wider boundary despite the new process overrides; Tower refuses that resume rather than silently reusing it. Local owner `allowsNativeAutoReviewEscalation` is an authorization declaration, not outer isolation.

Capability selection requires the verified native executable and no custom command/extra argument/PATH override. A Provider may leave the model blank or select another model; the native reviewer protocol is confirmed before every new/resumed turn, and any native rejection stops that turn without switching modes. A restricted policy must explicitly attest to an enforceable outer boundary for native auto-approved escalations; otherwise the option is disabled with `POLICY_ENFORCEMENT_UNAVAILABLE` and save/test/import/start return 403. Local owner permits the verified mode. This is a build/protocol gate, not an account or connection health guarantee.

## Evidence

`pnpm --filter @agent-tower/server exec tsx ../../scripts/smoke-codex-cli-auto-sandbox.mts` uses a private temporary `CODEX_HOME`, a 0600 authentication copy, and disposable workspaces. With the available `gpt-6-sol` OpenAI-compatible connection, the actual Executor/Driver/Coordinator run observed:

- New AUTO turn wrote inside the workspace without a Tower approval; native thread ID and usage were recorded.
- ASK resume, AUTO resume, and FULL_ACCESS exec resume preserved that thread. Each AUTO/ASK resume reconfirmed its reviewer and sandbox before the model turn.
- Native automatic review approved a requested temporary write outside the workspace. No Tower decision was sent.
- A requested loopback network action reached a temporary local HTTP server without a Tower decision.
- Cancelling AUTO after a command's first filesystem effect prevented its delayed final write. The old process tree's `tree_cleanup_completed` preceded the replacement ASK `started` event.
- All launches had confirmed tree cleanup. The smoke removed its temporary home and workspaces after `destroyAll()`.

Focused tests cover native mismatch before task delivery, remaining command/file approval forwarding, stale request rejection, policy/route status, launch projection, and owned process replacement. Later regression tests cover blank/other Provider models through capability, save/test and launch decisions, plus native rejection without a permission fallback. Other models, account types, platform builds, denial policy cases, MCP/host isolation, and long-term crash recovery remain unverified.

Repair verification uses a temporary `CODEX_HOME` whose inherited native config deliberately grants an extra writable directory and network access. CLI AUTO starts with the constrained boundary; normal new/resumed turns and cancellation are checked. The hostile FULL_ACCESS-to-AUTO resume is expected to fail before a model turn if native confirmation does not match the constrained boundary. Temporary outside-write, loopback network and harmless `sudo -n true` probes still did not produce a remaining human approval request; that end-to-end branch remains unaccepted.

Verification: the original implementation passed 177 affected and 98 adjacent tests. This repair passed 105 focused Service/Route/runtime/UI tests, 82 Codex Executor tests, and 80 adjacent Session/Driver tests (groups overlap). Shared, server, web and docs builds passed; `agent-tower-dev` skill validation passed. No browser E2E was performed in this implementation pass.
