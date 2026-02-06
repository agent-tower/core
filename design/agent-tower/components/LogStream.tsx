import React, { useState } from 'react';
import { LogEntry, LogType } from '../types';
import { IconAgentAction, IconAgentInfo, IconTool, IconToolExpanded, IconCursor } from './Icons';

interface LogStreamProps {
  logs: LogEntry[];
}

const LogItem: React.FC<{ log: LogEntry }> = ({ log }) => {
  const [isCollapsed, setIsCollapsed] = useState(log.isCollapsed || false);

  const toggle = () => setIsCollapsed(!isCollapsed);

  switch (log.type) {
    case LogType.Action:
      return (
        <div className="flex items-start gap-4 py-3 animate-in fade-in duration-300">
          <div className="mt-1 text-neutral-900 flex-shrink-0">
            <IconAgentAction />
          </div>
          <div className="text-neutral-800 leading-relaxed font-medium">
            {log.content}
          </div>
        </div>
      );

    case LogType.Info:
      return (
        <div className="flex items-start gap-4 py-3 animate-in fade-in duration-300">
          <div className="mt-1 text-neutral-400 flex-shrink-0">
            <IconAgentInfo />
          </div>
          <div className="text-neutral-600 leading-relaxed whitespace-pre-wrap">
            {log.content}
          </div>
        </div>
      );

    case LogType.Tool:
      return (
        <div className="py-2 animate-in fade-in slide-in-from-left-2 duration-300">
          <button 
            onClick={toggle}
            className="flex items-center gap-4 w-full group text-left"
          >
            <div className={`mt-0.5 flex-shrink-0 transition-colors ${isCollapsed ? 'text-neutral-400' : 'text-neutral-800'}`}>
              {isCollapsed ? <IconTool /> : <IconToolExpanded />}
            </div>
            <div className={`font-mono text-sm transition-colors ${isCollapsed ? 'text-neutral-500' : 'text-neutral-900 font-semibold'}`}>
              {log.title}
            </div>
          </button>
          
          {!isCollapsed && (
            <div className="ml-[30px] mt-2 p-3 bg-neutral-50 border border-neutral-200 rounded-sm text-sm font-mono text-neutral-600 overflow-x-auto">
              <pre>{log.content}</pre>
            </div>
          )}
        </div>
      );

    case LogType.User:
      return (
        <div className="my-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
          <div className="border border-neutral-200 rounded-sm overflow-hidden">
            <div className="bg-neutral-50 px-4 py-1 text-xs font-semibold text-neutral-500 uppercase tracking-wider border-b border-neutral-100">
              You
            </div>
            <div className="px-4 py-3 bg-white text-neutral-800 leading-relaxed">
              {log.content}
            </div>
          </div>
        </div>
      );

    case LogType.Cursor:
      return (
        <div className="inline-block align-text-bottom ml-1">
          <IconCursor className="animate-pulse text-neutral-900" />
        </div>
      );
      
    default:
      return null;
  }
};

export const LogStream: React.FC<LogStreamProps> = ({ logs }) => {
  return (
    <div className="flex flex-col gap-1 pb-4">
      {logs.map((log) => (
        <LogItem key={log.id} log={log} />
      ))}
    </div>
  );
};