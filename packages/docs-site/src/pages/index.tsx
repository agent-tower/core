import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';

import styles from './index.module.css';

const features = [
  {
    title: '统一任务面板',
    description:
      '把多个项目、任务、agent session 和 review 状态集中到一个可扫描的界面里。',
  },
  {
    title: '自动 Worktree 隔离',
    description:
      '每个任务对应独立分支和 git worktree，降低多个 agent 并行修改同一仓库时的冲突成本。',
  },
  {
    title: '实时日志与代码审查',
    description:
      '终端输出、结构化日志、Todo、token 用量、文件编辑器和 Git diff 在同一工作台里联动。',
  },
  {
    title: '面向 agent 的 MCP 接口',
    description:
      '外部 agent 可以读取任务板、创建任务、启动 session、查看 diff，并把结果推进到合并流程。',
  },
];

function HeroVisual() {
  return (
    <div className={styles.heroVisual} aria-label="Agent Tower interface preview">
      <div className={styles.previewTopbar}>
        <span />
        <span />
        <span />
        <strong>Agent Tower</strong>
      </div>
      <div className={styles.previewBody}>
        <aside className={styles.previewSidebar}>
          <div className={styles.previewSectionTitle}>IN REVIEW</div>
          <div className={clsx(styles.previewTask, styles.previewTaskActive)}>
            <span className={styles.statusReview} />
            <div>
              <strong>web / diff viewer</strong>
              <small>Codex · ready</small>
            </div>
          </div>
          <div className={styles.previewTask}>
            <span className={styles.statusRunning} />
            <div>
              <strong>server / MCP tools</strong>
              <small>Claude Code · running</small>
            </div>
          </div>
          <div className={styles.previewTask}>
            <span className={styles.statusTodo} />
            <div>
              <strong>docs / guide</strong>
              <small>Gemini · queued</small>
            </div>
          </div>
        </aside>
        <main className={styles.previewMain}>
          <div className={styles.previewHeader}>
            <div>
              <strong>Review Workspace</strong>
              <small>feat/task-diff-panel</small>
            </div>
            <button type="button">Merge</button>
          </div>
          <div className={styles.previewGrid}>
            <div className={styles.previewPanel}>
              <div className={styles.panelTitle}>Agent log</div>
              <p>Analyzed route structure and moved Git operations into a shared service.</p>
              <p>Running tests for workspace merge flow...</p>
              <div className={styles.logLine} />
              <div className={styles.logLineShort} />
            </div>
            <div className={styles.previewPanel}>
              <div className={styles.panelTitle}>Git changes</div>
              <pre>
                <code>{`+ export async function mergeWorkspace()
- app.post('/merge', handler)
+ tests passed`}</code>
              </pre>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function FeatureGrid() {
  return (
    <section className={styles.featureSection}>
      <div className="container">
        <div className={styles.sectionHeader}>
          <p>文档站首版覆盖</p>
          <h2>从安装到集成，按真实工作流组织</h2>
        </div>
        <div className={styles.features}>
          {features.map((feature) => (
            <article className={styles.feature} key={feature.title}>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function QuickLinks() {
  return (
    <section className={styles.quickLinks}>
      <div className="container">
        <Link className={styles.quickLink} to="/docs/getting-started/quick-start">
          <span>01</span>
          <strong>安装并启动</strong>
          <p>用全局 CLI 或源码开发模式跑起 Agent Tower。</p>
        </Link>
        <Link className={styles.quickLink} to="/docs/guide/workflow">
          <span>02</span>
          <strong>理解核心工作流</strong>
          <p>从创建任务到 agent 执行，再到审查和合并。</p>
        </Link>
        <Link className={styles.quickLink} to="/docs/integrations/mcp">
          <span>03</span>
          <strong>接入 MCP</strong>
          <p>让 AI agent 直接读取和操作任务板。</p>
        </Link>
      </div>
    </section>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();

  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <main>
        <section className={styles.hero}>
          <div className={clsx('container', styles.heroInner)}>
            <div className={styles.heroContent}>
              <div className={styles.heroBrand}>
                <img src="/img/agent-tower-logo.png" alt="Agent Tower" />
                <p className={styles.eyebrow}>Local-first AI agent control plane</p>
              </div>
              <h1>{siteConfig.title}</h1>
              <p className={styles.subtitle}>
                一个面向 AI coding agent 的本地任务管理面板。把 Claude Code、Codex、Gemini CLI、Cursor Agent 的任务、终端、代码变更和 review 流程放进同一个工作台。
              </p>
              <div className={styles.actions}>
                <Link className="button button--primary button--lg" to="/docs/getting-started/quick-start">
                  快速开始
                </Link>
                <Link className="button button--secondary button--lg" to="/docs/intro">
                  阅读文档
                </Link>
              </div>
              <div className={styles.install}>
                <code>npm install -g agent-tower</code>
                <code>agent-tower</code>
              </div>
            </div>
            <HeroVisual />
          </div>
        </section>
        <FeatureGrid />
        <QuickLinks />
      </main>
    </Layout>
  );
}
