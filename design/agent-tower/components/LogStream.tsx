import React, { useState } from 'react';
import { LogEntry, LogType } from '../types';
import { 
  Terminal, 
  Brain, 
  ChevronRight, 
  ChevronDown, 
  Check,
  Loader2,
  User
} from 'lucide-react';

interface LogStreamProps {
  logs: LogEntry[];
}

// 1. User Message Component - Slightly darker background (neutral-200)
const UserMessage: React.FC<{ content: string }> = ({ content }) => (
  <div className="flex justify-end mb-8 mt-4">
    <div className="relative bg-neutral-200 text-neutral-900 px-5 py-3.5 rounded-2xl rounded-tr-sm max-w-[85%] text-sm leading-relaxed whitespace-pre-wrap">
      {content}
    </div>
  </div>
);

// 2. Thinking Component (Collapsible)
const ThinkingBlock: React.FC<{ content: string; isOpenDefault?: boolean }> = ({ content, isOpenDefault = false }) => {
  const [isOpen, setIsOpen] = useState(isOpenDefault);
  
  return (
    <div className="mb-4">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-xs font-medium text-neutral-400 hover:text-neutral-600 transition-colors select-none"
      >
        <Brain size={12} />
        <span>Thinking Process</span>
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      
      {isOpen && (
        <div className="mt-2 pl-3 border-l-2 border-neutral-100">
           <div className="text-xs text-neutral-500 font-mono leading-relaxed whitespace-pre-wrap">
             {content}
           </div>
        </div>
      )}
    </div>
  );
};

// 3. Tool/Action Component (Minimalist "Pill" or "Status Line")
const ToolBlock: React.FC<{ title: string; content: string; type: LogType }> = ({ title, content, type }) => {
  const [isOpen, setIsOpen] = useState(false);
  const isAction = type === LogType.Action;

  // Action (Status update) is very subtle
  if (isAction) {
    return (
      <div className="flex items-center gap-2 py-1.5 text-xs text-neutral-400 animate-in fade-in slide-in-from-left-1 duration-300">
        <div className="w-1 h-1 rounded-full bg-neutral-300" />
        <span>{content}</span>
      </div>
    );
  }

  // Tool (Command/File Operation) is interactive
  return (
    <div className="mb-3 group">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono w-full text-left transition-all ${
          isOpen 
          ? 'bg-neutral-50 border-neutral-200 text-neutral-700' 
          : 'bg-white border-neutral-100 text-neutral-500 hover:border-neutral-200 hover:text-neutral-700'
        }`}
      >
        <Terminal size={12} className="opacity-70" />
        <span className="flex-1 truncate font-medium">{title || 'System Operation'}</span>
        <span className="opacity-0 group-hover:opacity-100 transition-opacity text-neutral-400">
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {isOpen && (
        <div className="mt-1 bg-neutral-900 rounded-lg p-3 overflow-x-auto">
          <code className="text-[11px] font-mono text-neutral-300 whitespace-pre">
            {content}
          </code>
        </div>
      )}
    </div>
  );
};

// 4. Main Agent Text Component
const AgentText: React.FC<{ content: string }> = ({ content }) => (
  <div className="text-sm text-neutral-800 leading-7 mb-4 whitespace-pre-wrap animate-in fade-in duration-500">
    {content}
  </div>
);

export const LogStream: React.FC<LogStreamProps> = ({ logs }) => {
  return (
    <div className="flex flex-col w-full mx-auto pb-4">
      {logs.map((log) => {
        // HACK: Identify "Thinking" blocks by title from the mock data
        if (log.title === 'Thinking' || log.content.startsWith('Thinking:')) {
          return <ThinkingBlock key={log.id} content={log.content} />;
        }

        switch (log.type) {
          case LogType.User:
            return <UserMessage key={log.id} content={log.content} />;
          
          case LogType.Tool:
            return <ToolBlock key={log.id} type={log.type} title={log.title || 'Tool'} content={log.content} />;
            
          case LogType.Action:
            return <ToolBlock key={log.id} type={log.type} title="Action" content={log.content} />;
          
          case LogType.Info:
            return <AgentText key={log.id} content={log.content} />;

          case LogType.Cursor:
            return (
                <div key={log.id} className="h-4 w-2 bg-neutral-900 animate-pulse mt-1 inline-block align-middle" />
            );
            
          default:
            return null;
        }
      })}
    </div>
  );
};