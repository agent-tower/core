#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEAM_TEMPLATE_NAME = '工程团队 v1.4';
const CODEX_PROVIDER_NAME = 'Codex 自建';
const DEFAULT_BASE_URL = 'http://localhost:12580';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const help = args.includes('--help') || args.includes('-h');
const baseUrlArg = args.find((arg) => arg.startsWith('--base-url='));
const baseUrl = normalizeBaseUrl(
  baseUrlArg?.slice('--base-url='.length)
  || process.env.AGENT_TOWER_BASE_URL
  || DEFAULT_BASE_URL
);

const trueCaps = {
  readRoom: true,
  postRoomMessage: true,
  mentionMembers: true,
  stopMemberWork: false,
  markReadyForReview: false,
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  readDiff: false,
  mergeWorkspace: false,
};

const memberSpecs = [
  {
    name: '负责人',
    aliases: ['leader-v1.4', 'engineering-leader-v1.4', '负责人-v1.4', '项目负责人-v1.4'],
    promptPath: 'docs/prompt/v1.4-engineering-team/team-room-leader-prompt.md',
    workspacePolicy: 'none',
    triggerPolicy: 'USER_MESSAGES',
    sessionPolicy: 'resume_last',
    queueManagementPolicy: 'team_pending',
    avatar: '/avatars/presets/avatar-preset-10-product-manager.png',
    capabilities: {
      ...trueCaps,
      stopMemberWork: true,
    },
  },
  {
    name: '产品经理',
    aliases: ['pm-v1.4', 'product-manager-v1.4', 'spec-owner-v1.4', '产品经理-v1.4', '产品负责人-v1.4', '需求澄清-v1.4'],
    promptPath: 'docs/prompt/v1.4-engineering-team/team-room-product-manager-prompt.md',
    workspacePolicy: 'dedicated',
    triggerPolicy: 'MENTION_ONLY',
    sessionPolicy: 'resume_last',
    queueManagementPolicy: 'own_only',
    avatar: '/avatars/presets/avatar-preset-21-consultant.png',
    capabilities: {
      ...trueCaps,
      readFiles: true,
      writeFiles: true,
    },
  },
  {
    name: '原型设计师',
    aliases: ['prototyper-v1.4', 'prototype-designer-v1.4', 'wireframe-v1.4', '原型设计师-v1.4', '原型图-v1.4', '线框图-v1.4'],
    promptPath: 'docs/prompt/v1.4-engineering-team/team-room-prototyper-prompt.md',
    workspacePolicy: 'dedicated',
    triggerPolicy: 'MENTION_ONLY',
    sessionPolicy: 'resume_last',
    queueManagementPolicy: 'own_only',
    avatar: '/avatars/presets/avatar-preset-16-ui-designer.png',
    capabilities: {
      ...trueCaps,
      readFiles: true,
      writeFiles: true,
    },
  },
  {
    name: '技术团队负责人',
    aliases: ['tech-lead-v1.4', 'technical-lead-v1.4', 'architect-v1.4', '技术负责人-v1.4', '技术团队负责人-v1.4', '架构师-v1.4'],
    promptPath: 'docs/prompt/v1.4-engineering-team/team-room-tech-lead-prompt.md',
    workspacePolicy: 'dedicated',
    triggerPolicy: 'MENTION_ONLY',
    sessionPolicy: 'resume_last',
    queueManagementPolicy: 'own_only',
    avatar: '/avatars/presets/avatar-preset-14-mentor.png',
    capabilities: {
      ...trueCaps,
      stopMemberWork: true,
      readFiles: true,
      writeFiles: true,
      readDiff: true,
      mergeWorkspace: true,
    },
  },
  {
    name: '实现工程师',
    aliases: ['implementer-v1.4', 'full-stack-engineer-v1.4', '实现工程师-v1.4', '全栈工程师-v1.4'],
    promptPath: 'docs/prompt/v1.4-engineering-team/team-room-implementer-prompt.md',
    workspacePolicy: 'dedicated',
    triggerPolicy: 'MENTION_ONLY',
    sessionPolicy: 'new_per_request',
    queueManagementPolicy: 'own_only',
    avatar: '/avatars/presets/avatar-preset-06-frontend.png',
    capabilities: {
      ...trueCaps,
      markReadyForReview: true,
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      readDiff: true,
    },
  },
  {
    name: '审查工程师',
    aliases: ['reviewer-v1.4', 'code-reviewer-v1.4', '审查工程师-v1.4', '代码审查-v1.4'],
    promptPath: 'docs/prompt/v1.4-engineering-team/team-room-reviewer-prompt.md',
    workspacePolicy: 'dedicated',
    triggerPolicy: 'MENTION_ONLY',
    sessionPolicy: 'new_per_request',
    queueManagementPolicy: 'own_only',
    avatar: '/avatars/presets/avatar-preset-15-reviewer.png',
    capabilities: {
      ...trueCaps,
      readFiles: true,
      runCommands: true,
      readDiff: true,
    },
  },
  {
    name: '测试工程师',
    aliases: ['e2e-v1.4', 'e2e-tester-v1.4', 'qa-tester-v1.4', '测试工程师-v1.4', '端到端测试-v1.4'],
    promptPath: 'docs/prompt/v1.4-engineering-team/team-room-e2e-tester-prompt.md',
    workspacePolicy: 'dedicated',
    triggerPolicy: 'MENTION_ONLY',
    sessionPolicy: 'new_per_request',
    queueManagementPolicy: 'own_only',
    avatar: '/avatars/presets/avatar-preset-03-tester.png',
    capabilities: {
      ...trueCaps,
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      readDiff: true,
    },
  },
];

if (help) {
  printHelp();
  process.exit(0);
}

main().catch((error) => {
  console.error('');
  console.error('Import failed.');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('No PATCH/DELETE cleanup was attempted. Inspect created IDs above before retrying.');
  process.exit(1);
});

async function main() {
  const modeLabel = apply ? 'APPLY' : 'DRY-RUN';
  console.log(`Engineering Team v1.4 import (${modeLabel})`);
  console.log(`Base URL: ${baseUrl}`);
  console.log('');

  const provider = await resolveCodexProvider();
  const presets = await fetchJson('/member-presets');
  const templates = await fetchJson('/team-templates');
  const plannedMembers = await buildPlannedMembers(provider.id);
  const conflicts = findConflicts({ presets, templates, plannedMembers });

  printPlan({ provider, plannedMembers, conflicts });

  if (conflicts.length > 0) {
    throw new Error('Conflict check failed. Resolve conflicts before applying.');
  }

  if (!apply) {
    console.log('');
    console.log('Dry-run only. No POST requests were sent.');
    console.log('To write after confirmation: node scripts/import-engineering-team-v1-4.mjs --apply');
    return;
  }

  console.log('');
  console.log('Applying: creating member presets...');
  const createdPresets = [];
  for (const member of plannedMembers) {
    const created = await fetchJson('/member-presets', {
      method: 'POST',
      body: {
        name: member.name,
        aliases: member.aliases,
        providerId: member.providerId,
        rolePrompt: member.rolePrompt,
        capabilities: member.capabilities,
        workspacePolicy: member.workspacePolicy,
        triggerPolicy: member.triggerPolicy,
        sessionPolicy: member.sessionPolicy,
        queueManagementPolicy: member.queueManagementPolicy,
        avatar: member.avatar,
      },
    });
    createdPresets.push(created);
    console.log(`- ${created.name}: ${created.id}`);
  }

  console.log('');
  console.log('Applying: creating team template...');
  const createdTemplate = await fetchJson('/team-templates', {
    method: 'POST',
    body: {
      name: TEAM_TEMPLATE_NAME,
      members: createdPresets.map((preset, position) => ({
        memberPresetId: preset.id,
        position,
      })),
    },
  });

  console.log(`- ${createdTemplate.name}: ${createdTemplate.id}`);
  console.log('');
  console.log('Import complete.');
}

function printHelp() {
  console.log(`Usage:
  node scripts/import-engineering-team-v1-4.mjs [--apply] [--base-url=http://localhost:12580]

Default mode is dry-run. Dry-run sends only GET requests and prints the planned additions.
--apply is required to POST new MemberPreset and TeamTemplate records.
`);
}

function normalizeBaseUrl(value) {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

async function resolveCodexProvider() {
  const providersResponse = await fetchJson('/providers');
  const providers = providersResponse.map((item) => item.provider ?? item);
  const provider = providers.find((item) => item.name === CODEX_PROVIDER_NAME);
  if (!provider) {
    const available = providers.map((item) => `${item.name ?? '<unnamed>'} (${item.id ?? '<no-id>'})`).join(', ');
    throw new Error(`Provider "${CODEX_PROVIDER_NAME}" was not found. Available providers: ${available}`);
  }
  if (!provider.id) {
    throw new Error(`Provider "${CODEX_PROVIDER_NAME}" is missing id.`);
  }
  return provider;
}

async function buildPlannedMembers(providerId) {
  return Promise.all(memberSpecs.map(async (spec) => {
    const absolutePromptPath = path.join(repoRoot, spec.promptPath);
    const rolePrompt = await readFile(absolutePromptPath, 'utf8');
    return {
      ...spec,
      providerId,
      rolePrompt,
      rolePromptBytes: Buffer.byteLength(rolePrompt, 'utf8'),
    };
  }));
}

function findConflicts({ presets, templates, plannedMembers }) {
  const conflicts = [];
  const template = templates.find((item) => item.name === TEAM_TEMPLATE_NAME);
  if (template) {
    conflicts.push(`TeamTemplate name already exists: ${TEAM_TEMPLATE_NAME} (${template.id})`);
  }

  const plannedAliases = new Set(plannedMembers.flatMap((member) => member.aliases));
  for (const preset of presets) {
    const overlap = (preset.aliases ?? []).filter((alias) => plannedAliases.has(alias));
    if (overlap.length > 0) {
      conflicts.push(`MemberPreset alias already exists on "${preset.name}" (${preset.id}): ${overlap.join(', ')}`);
    }
  }

  return conflicts;
}

function printPlan({ provider, plannedMembers, conflicts }) {
  console.log(`Provider: ${provider.name} (${provider.id})`);
  console.log(`TeamTemplate: ${TEAM_TEMPLATE_NAME}`);
  console.log('');
  console.log('Planned MemberPresets:');
  plannedMembers.forEach((member, index) => {
    console.log(`${index + 1}. ${member.name}`);
    console.log(`   aliases: ${member.aliases.join(', ')}`);
    console.log(`   providerId: ${member.providerId}`);
    console.log(`   policies: workspace=${member.workspacePolicy}, trigger=${member.triggerPolicy}, session=${member.sessionPolicy}, queue=${member.queueManagementPolicy}`);
    console.log(`   capabilities: ${enabledCapabilities(member.capabilities).join(', ') || '<none>'}`);
    console.log(`   rolePrompt: ${member.promptPath} (${member.rolePromptBytes} bytes)`);
  });

  console.log('');
  if (conflicts.length === 0) {
    console.log('Conflict check: no v1.4 template/alias conflicts found.');
    return;
  }
  console.log('Conflict check: failed');
  conflicts.forEach((conflict) => console.log(`- ${conflict}`));
}

function enabledCapabilities(capabilities) {
  return Object.entries(capabilities)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
}

async function fetchJson(pathname, options = {}) {
  const method = options.method ?? 'GET';
  const url = `${baseUrl}/api${pathname}`;
  const init = { method };
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let data = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`${method} ${url} failed with ${response.status}: ${message}`);
  }
  return data;
}
