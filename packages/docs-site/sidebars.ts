import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  guideSidebar: [
    {
      type: 'doc',
      id: 'intro',
      label: '概览',
    },
    {
      type: 'category',
      label: '快速开始',
      collapsed: false,
      items: [
        'getting-started/quick-start',
        'getting-started/source-development',
        'getting-started/project-setup',
      ],
    },
    {
      type: 'category',
      label: '使用指南',
      collapsed: false,
      items: [
        'guide/workflow',
        'guide/projects-and-tasks',
        'guide/workspaces',
        'guide/sessions',
        'guide/review-and-merge',
        'guide/mobile-access',
      ],
    },
    {
      type: 'category',
      label: '核心概念',
      collapsed: false,
      items: [
        'concepts/product-model',
        'concepts/architecture',
        'concepts/state-machine',
      ],
    },
    {
      type: 'category',
      label: '集成',
      collapsed: false,
      items: [
        'integrations/agent-providers',
        'integrations/mcp',
        'integrations/notifications',
        'integrations/tunnel',
      ],
    },
    {
      type: 'category',
      label: '参考',
      collapsed: false,
      items: [
        'reference/api',
        'reference/socket-events',
        'reference/environment',
        'reference/repository-layout',
      ],
    },
    {
      type: 'category',
      label: '排障',
      collapsed: false,
      items: [
        'troubleshooting/common-issues',
        'troubleshooting/node-pty',
      ],
    },
  ],
};

export default sidebars;
