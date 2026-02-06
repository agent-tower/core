import { Project, Task, TaskStatus, LogType } from './types';

export const PROJECTS: Project[] = [
  { id: 'p1', name: 'Tower', color: 'text-indigo-600' },
  { id: 'p2', name: 'Web', color: 'text-emerald-600' },
  { id: 'p3', name: 'SDK', color: 'text-rose-600' },
];

export const MOCK_TASKS: Task[] = [
  // --- Review ---
  {
    id: 't1',
    projectId: 'p1',
    title: 'API Refactor',
    status: TaskStatus.Review,
    agent: 'Claude Code',
    branch: 'feat/api',
    description: 'Refactor API routes to separate user related endpoints into independent modules.',
    logs: [] // Populated in detail view usually
  },
  {
    id: 't2',
    projectId: 'p2',
    title: 'Form Validation',
    status: TaskStatus.Review,
    agent: 'GPT-4o',
    branch: 'fix/forms',
    description: 'Add Zod validation to the registration flow.',
    logs: []
  },
  // --- Running ---
  {
    id: 't3',
    projectId: 'p1',
    title: 'Login Feature',
    status: TaskStatus.Running,
    agent: 'Claude Code',
    branch: 'feat/auth',
    description: 'Implement OAuth2 login flow with Google and GitHub providers.',
    logs: [
        { id: 'l1', type: LogType.Action, content: 'Analyzing project structure...' },
        { id: 'l2', type: LogType.Tool, title: 'Thinking', content: 'I need to check the current auth configuration in `src/config/auth.ts` to see what providers are currently supported.', isCollapsed: true },
        { id: 'l3', type: LogType.Tool, title: 'Read src/routes/index.ts', content: 'File content of src/routes/index.ts...', isCollapsed: true },
        { id: 'l4', type: LogType.Info, content: 'Found that all API routes are currently in index.ts. I plan to split them into:\n- users.ts\n- projects.ts' },
        { id: 'l5', type: LogType.Tool, title: 'Write src/routes/users.ts', content: '...', isCollapsed: true },
        { id: 'l6', type: LogType.Tool, title: 'Edit src/routes/index.ts', content: '...', isCollapsed: true },
        { id: 'l7', type: LogType.Info, content: 'Route separation complete. Adding type definitions now...' },
        { id: 'l8', type: LogType.User, content: 'Please add JSDoc comments to the new functions while you are at it.' },
        { id: 'l9', type: LogType.Action, content: 'Understood. Adding JSDoc to every exported function.' },
        { id: 'l10', type: LogType.Tool, title: 'Edit src/types/index.ts', content: '...', isCollapsed: true },
        { id: 'l11', type: LogType.Action, content: 'Running verification tests...' },
        { id: 'l12', type: LogType.Tool, title: 'Bash: npm test', content: 'PASS src/routes/users.test.ts', isCollapsed: false },
        { id: 'l13', type: LogType.Info, content: 'All tests passed. Task complete.' },
        { id: 'l14', type: LogType.Cursor, content: '' }
    ]
  },
  {
    id: 't4',
    projectId: 'p3',
    title: 'Type Fixes',
    status: TaskStatus.Running,
    agent: 'Gemini 2.0',
    branch: 'fix/types',
    description: 'Resolve TypeScript errors in the build pipeline.',
    logs: []
  },
  {
    id: 't5',
    projectId: 'p2',
    title: 'Home Optimization',
    status: TaskStatus.Running,
    agent: 'Claude Code',
    branch: 'chore/perf',
    description: 'Reduce bundle size by 20%.',
    logs: []
  },
  // --- Pending ---
  { id: 't6', projectId: 'p3', title: 'Unit Tests', status: TaskStatus.Pending, agent: 'AutoGPT', branch: 'test/core', description: 'Increase coverage to 80%.', logs: [] },
  { id: 't7', projectId: 'p1', title: 'DB Migration', status: TaskStatus.Pending, agent: 'Claude', branch: 'feat/db', description: 'Add new columns.', logs: [] },
  { id: 't8', projectId: 'p2', title: 'Dark Mode', status: TaskStatus.Pending, agent: 'GPT-4', branch: 'feat/ui', description: 'Implement dark mode context.', logs: [] },
  { id: 't9', projectId: 'p3', title: 'Documentation', status: TaskStatus.Pending, agent: 'Claude', branch: 'docs/api', description: 'Generate Swagger docs.', logs: [] },
  { id: 't10', projectId: 'p1', title: 'CI Pipeline', status: TaskStatus.Pending, agent: 'Gemini', branch: 'chore/ci', description: 'Fix GitHub Actions.', logs: [] },
  // --- Done ---
  { id: 't11', projectId: 'p1', title: 'Init Repo', status: TaskStatus.Done, agent: 'Human', branch: 'main', description: 'Initial commit.', logs: [] },
];
