import type { Config } from '@docusaurus/types';
import type { Options as PresetOptions, ThemeConfig } from '@docusaurus/preset-classic';
import { createRequire } from 'node:module';
import path from 'node:path';
import { themes as prismThemes } from 'prism-react-renderer';

const require = createRequire(import.meta.url);
const docusaurusRequire = createRequire(require.resolve('@docusaurus/core/package.json'));
const resolveFromDocusaurus = (moduleId: string) => docusaurusRequire.resolve(moduleId);

const config: Config = {
  title: 'Agent Tower',
  tagline: 'A local-first command center for AI coding agents.',
  favicon: 'img/agent-tower-logo.png',

  url: 'https://agent-tower.github.io',
  baseUrl: '/',

  organizationName: 'agent-tower',
  projectName: 'core',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'zh-CN',
    locales: ['zh-CN'],
    localeConfigs: {
      'zh-CN': {
        label: '简体中文',
      },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: 'docs',
          editUrl: 'https://github.com/agent-tower/core/tree/main/packages/docs-site/',
          showLastUpdateAuthor: true,
          showLastUpdateTime: true,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies PresetOptions,
    ],
  ],

  webpack: {
    jsLoader: (isServer) => {
      const loader = resolveFromDocusaurus('babel-loader');

      if (!isServer) {
        return {
          loader,
          options: {
            presets: [resolveFromDocusaurus('@docusaurus/babel/preset')],
            babelrc: false,
            configFile: false,
            caller: { name: 'client' },
          },
        };
      }

      const absoluteRuntime = path.dirname(resolveFromDocusaurus('@babel/runtime/package.json'));

      return {
        loader,
        options: {
          babelrc: false,
          configFile: false,
          caller: { name: 'server' },
          compact: true,
          presets: [
            [
              resolveFromDocusaurus('@babel/preset-env'),
              {
                targets: { node: 'current' },
                modules: false,
              },
            ],
            [
              resolveFromDocusaurus('@babel/preset-react'),
              {
                runtime: 'automatic',
              },
            ],
            resolveFromDocusaurus('@babel/preset-typescript'),
          ],
          plugins: [
            [
              resolveFromDocusaurus('@babel/plugin-transform-runtime'),
              {
                corejs: false,
                helpers: true,
                version: docusaurusRequire('@babel/runtime/package.json').version,
                regenerator: true,
                useESModules: true,
                absoluteRuntime,
              },
            ],
            resolveFromDocusaurus('@babel/plugin-syntax-dynamic-import'),
          ],
        },
      };
    },
  },

  plugins: [
    './plugins/resolve-weak-fallback.cjs',
    './plugins/server-commonjs-boundary.cjs',
  ],

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  themeConfig: {
    image: 'img/social-card.svg',
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Agent Tower',
      logo: {
        alt: 'Agent Tower',
        src: 'img/agent-tower-logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'guideSidebar',
          position: 'left',
          label: '文档',
        },
        {
          to: '/docs/getting-started/quick-start',
          label: '快速开始',
          position: 'left',
        },
        {
          to: '/docs/reference/api',
          label: 'API',
          position: 'left',
        },
        {
          href: 'https://github.com/agent-tower/core',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: '文档',
          items: [
            {
              label: '快速开始',
              to: '/docs/getting-started/quick-start',
            },
            {
              label: '核心工作流',
              to: '/docs/guide/workflow',
            },
            {
              label: 'MCP 集成',
              to: '/docs/integrations/mcp',
            },
          ],
        },
        {
          title: '参考',
          items: [
            {
              label: 'REST API',
              to: '/docs/reference/api',
            },
            {
              label: 'Socket.IO 事件',
              to: '/docs/reference/socket-events',
            },
            {
              label: '环境变量',
              to: '/docs/reference/environment',
            },
          ],
        },
        {
          title: '项目',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/agent-tower/core',
            },
            {
              label: 'Issue Tracker',
              href: 'https://github.com/agent-tower/core/issues',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Agent Tower. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies ThemeConfig,

};

export default config;
