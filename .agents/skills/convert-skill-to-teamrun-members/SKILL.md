---
name: convert-skill-to-teamrun-members
description: Convert an external skill, expert methodology, repository, workflow, or role set into Agent Tower TeamRun members, MemberPresets, rolePrompt documents, Leader or PM Leader orchestration, and optional TeamRun templates. Use when the user asks to turn a skill/repo/method/process into TeamRun roles, team members, presets, prompts, or a reusable Agent Tower team configuration.
---

# Convert Skill to TeamRun Members

Use this skill to translate a source methodology into an Agent Tower TeamRun team design. Keep the output practical: roles, permissions, prompts, orchestration, landing steps, and verification.

## Workflow

1. Read the source material.
   - Inspect the external skill, repo, docs, examples, and any existing prompt files.
   - Identify capability modules, expected artifacts, inputs, outputs, handoff points, and explicit boundaries.
   - Separate reusable method knowledge from one-off conversation history; do not paste long source text into prompts.

2. Decide what should become a member.
   - Create a TeamRun member only when the capability has a distinct responsibility, clear input/output contract, and meaningful independent result.
   - Put routing logic, sequencing rules, and result integration in the Leader or PM Leader prompt instead of creating a member for every concept.
   - Do not memberize reference material, low-value checklists, pure terminology, or work that is better handled by an existing Implementer/Reviewer/Tester role.

3. Define each role configuration.
   - Specify `name`, `aliases`, `providerId` recommendation if known, `workspacePolicy`, `triggerPolicy`, `sessionPolicy`, `queueManagementPolicy`, and capabilities.
   - Use the exact capability fields: `readRoom`, `postRoomMessage`, `mentionMembers`, `stopMemberWork`, `markReadyForReview`, `readFiles`, `writeFiles`, `runCommands`, `readDiff`, `mergeWorkspace`.
   - Default expert and specialist roles to `triggerPolicy: MENTION_ONLY` so the Leader explicitly invokes them.
   - Default user-entry Leaders to `triggerPolicy: USER_MESSAGES`.
   - Default specialists to minimum capabilities: usually `readRoom` and `postRoomMessage`; add `mentionMembers` only when they must hand off work.
   - Use `workspacePolicy: none` when a role does not need repository access.
   - Use `workspacePolicy: shared` with `readFiles` for roles that inspect docs/code but do not edit.
   - Grant `writeFiles`, `runCommands`, `readDiff`, or `mergeWorkspace` only when the role's normal job requires them.
   - Use `sessionPolicy: resume_last` for roles that benefit from continuity, and `new_per_request` for independent audit/check roles.
   - Use `queueManagementPolicy: own_only` for specialists and `team_pending` only for coordinator roles that must manage team queues.

4. Write role prompts.
   - Do not duplicate system or Team Room shared protocols in `rolePrompt`; assume the system layer injects them.
   - Include the role's mission, responsibilities, non-responsibilities, inputs, output/result contract, collaboration rules, and verification expectations.
   - Make each role aware of its boundaries: it should not impersonate other specialists, implementers, reviewers, testers, or the Leader.
   - Keep prompts focused on operating behavior, not full copies of the source methodology.

5. Design Leader orchestration.
   - Decide whether the existing ordinary Leader is enough or whether a separate domain Leader is cleaner.
   - Keep ordinary Leader and domain Leader separate when the workflow is specialized enough to add many domain rules.
   - Put these rules in the Leader prompt: when to call each specialist, required input for each delegation, how to integrate results, when to ask the user, and when to hand off to engineering, review, testing, or audit.
   - The Leader should coordinate and synthesize; it should not personally produce complete expert artifacts that belong to specialist roles.
   - Do not let multiple specialists listen to all user messages by default.

6. Land the artifacts.
   - Prefer Markdown prompt docs first when the team design is still being reviewed.
   - Create or update MemberPresets only after the role prompts and configurations are clear.
   - Create a TeamRun template only when the user explicitly wants a reusable team composition.
   - If configuring through the UI, use browser automation to create presets and then reopen the details to verify saved values.

7. Verify.
   - Review generated prompts for duplicated system protocols, vague boundaries, overbroad permissions, and missing result contracts.
   - Verify MemberPreset fields in UI or API: names, aliases, provider, policies, capabilities, and rolePrompt source.
   - Verify TeamRun template membership only if a template was requested.
   - Check git diff when editing files; it should contain only the intended prompt/skill/template artifacts.

## Product-Team Defaults

When converting product-management skills or methods, prefer this proven pattern unless the source material clearly argues otherwise:

- Use a user-entry `PM Leader` or `Product Owner` with `triggerPolicy: USER_MESSAGES`, `workspacePolicy: none`, `sessionPolicy: resume_last`, `queueManagementPolicy: team_pending`, and coordinator capabilities such as `readRoom`, `postRoomMessage`, `mentionMembers`, and optionally `stopMemberWork`.
- Use expert PM roles with `triggerPolicy: MENTION_ONLY` and `queueManagementPolicy: own_only`.
- Product strategy and discovery roles usually need no repository access.
- Execution/specification roles may use `workspacePolicy: shared` plus `readFiles` when they need project docs or code context.
- Shipping/audit roles may use `workspacePolicy: shared`, `readFiles`, and `readDiff`; they should not write, run commands, or merge by default.
- Keep PM experts from replacing engineering roles. They prepare strategy, discovery, PRD, acceptance criteria, audit findings, and handoff inputs; Implementers, Reviewers, and Testers do their own work.

## Prompt Placement

- Put generic Team Room behavior, visibility rules, result requirements, security rules, and message mechanics in shared protocol, not in individual role prompts.
- Put domain orchestration, routing, sequencing, result integration, queue handling, and user decision framing in the Leader or PM Leader prompt.
- Put specialist expertise, input expectations, artifact shape, handoff rules, and strict non-goals in each specialist `rolePrompt`.
- Put provider IDs, avatars, preset names, aliases, and capability matrices in MemberPreset or TeamTemplate docs rather than burying them only inside role prompts.

## Output Template

```markdown
## Role Inventory

- Role name: purpose, main artifact, why it should or should not be a TeamRun member.

## Recommended MemberPreset Configuration

| Role | triggerPolicy | workspacePolicy | sessionPolicy | queueManagementPolicy | Key capabilities |
| --- | --- | --- | --- | --- | --- |
| ... | ... | ... | ... | ... | ... |

## Leader Orchestration

- User-entry member:
- When to call each specialist:
- Required delegation input:
- How to integrate results:
- Engineering/review/testing/audit handoff:

## Prompt Artifacts

- Files to create or update:
- Role prompt boundaries:
- Shared protocol content that should not be duplicated:

## Landing Steps

- Markdown prompts:
- MemberPresets:
- Optional TeamRun template:
- UI/API verification:

## Risks and Open Questions

- Missing source context:
- Permission risks:
- Roles that may overlap:
- User decisions required:
```

## Guardrails

- Do not update existing MemberPresets, TeamRun templates, or prompts unless the user explicitly asks.
- Do not create broad compatibility prompts when a separate domain Leader would be simpler and safer.
- Do not grant implementation powers to expert advisory roles by default.
- Do not overwrite project operating files such as `AGENTS.md` or `CLAUDE.md` from a source methodology without explicit confirmation; propose a patch or separate prompt artifact instead.
- Do not present uncreated members or templates as if they already exist; distinguish design, docs, UI/API configuration, and verified runtime state.
