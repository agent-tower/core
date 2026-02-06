export enum TaskStatus {
  Review = 'Review',
  Running = 'Running',
  Pending = 'Pending',
  Done = 'Done'
}

export enum LogType {
  Action = 'Action',     // ◆ Agent Action
  Info = 'Info',         // ◇ Agent Explanation/Thinking
  Tool = 'Tool',         // ▶ Tool Call
  User = 'User',         // User Message
  Cursor = 'Cursor'      // █ Output Cursor
}

export interface Project {
  id: string;
  name: string;
  color: string; // Tailwind text color class, e.g., 'text-blue-600'
}

export interface LogEntry {
  id: string;
  type: LogType;
  content: string;
  title?: string; // For tools or collapsed sections
  isCollapsed?: boolean;
  children?: LogEntry[]; // For nested thoughts or tool outputs if needed extended
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  agent: string;
  branch: string;
  description: string;
  logs: LogEntry[];
}
