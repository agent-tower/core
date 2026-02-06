import React, { useState, useEffect, useRef } from 'react';
import { Task, TaskStatus } from '../types';
import { PROJECTS } from '../constants';
import { IconRunning, IconReview, IconDone, IconPending } from './Icons';
import { LogStream } from './LogStream';
import { WorkspacePanel } from './WorkspacePanel';
import { Send, PanelRightClose, PanelRightOpen, Paperclip, Mic, ArrowUp } from 'lucide-react';

interface TaskDetailProps {
  task: Task | null;
}

export const TaskDetail: React.FC<TaskDetailProps> = ({ task }) => {
  const [input, setInput] = useState('');
  
  // Layout State: Chat is now the controlled width, Workspace is flex-1
  // Increased default width from 450 to 675 (+50%)
  const [chatWidth, setChatWidth] = useState(675); 
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(true);
  const [isResizing, setIsResizing] = useState(false);
  
  // Refs for smooth resizing
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [task?.logs]);

  // Handle Resizing Logic (Controlling Chat Width)
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const deltaX = e.clientX - startXRef.current;
      const newWidth = startWidthRef.current + deltaX;
      // Clamp width between 320px and 1200px (increased max width for larger screens)
      const clampedWidth = Math.max(320, Math.min(newWidth, 1200));
      setChatWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const handleMouseDownResize = (e: React.MouseEvent) => {
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = chatWidth;
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      // Ensure minimum height is respected
      textareaRef.current.style.height = `${Math.max(60, Math.min(scrollHeight, 300))}px`;
    }
  };

  if (!task) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-white text-neutral-400 select-none">
        <div className="w-16 h-16 bg-neutral-50 rounded-2xl border border-neutral-100 flex items-center justify-center mb-6">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-neutral-300">
                <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor"/>
                <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
        </div>
        <h3 className="text-neutral-900 font-medium mb-2 text-lg">Agent Tower</h3>
        <p className="text-sm max-w-sm text-center text-neutral-500 leading-relaxed">
            Select a task from the sidebar to view logs, monitor execution, or interact with an agent.
        </p>
      </div>
    );
  }

  const project = PROJECTS.find(p => p.id === task.projectId);

  return (
    <div className="flex-1 flex flex-col h-full bg-white relative overflow-hidden">
      {/* Minimal Header */}
      <div className="px-6 py-4 flex items-center justify-between border-b border-neutral-100 bg-white/80 backdrop-blur-sm z-20 flex-shrink-0">
        <div className="flex flex-col">
            <div className="flex items-center gap-2 mb-0.5">
                <span className={`text-xs font-semibold uppercase tracking-wider ${project?.color || 'text-neutral-500'}`}>
                    {project?.name}
                </span>
                <span className="text-neutral-300 text-xs">/</span>
                <span className="text-xs text-neutral-500 font-mono">{task.branch}</span>
            </div>
            <h2 className="text-lg font-bold text-neutral-900">{task.title}</h2>
        </div>
        
        <div className="flex items-center gap-4">
             {/* Status Badge */}
            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${
                task.status === TaskStatus.Running ? 'bg-blue-50 text-blue-700 border-blue-100' :
                task.status === TaskStatus.Review ? 'bg-amber-50 text-amber-700 border-amber-100' :
                'bg-neutral-50 text-neutral-600 border-neutral-100'
            }`}>
                {task.status === TaskStatus.Running && <IconRunning className="w-3 h-3 animate-pulse" />}
                {task.status === TaskStatus.Review && <IconReview className="w-3 h-3" />}
                {task.status === TaskStatus.Pending && <IconPending className="w-3 h-3" />}
                {task.status === TaskStatus.Done && <IconDone className="w-3 h-3" />}
                <span>{task.status}</span>
            </div>

            {/* Toggle Workspace */}
            <button 
                onClick={() => setIsWorkspaceOpen(!isWorkspaceOpen)}
                className="text-neutral-400 hover:text-neutral-900 transition-colors"
                title="Toggle Workspace"
            >
                {isWorkspaceOpen ? <PanelRightClose size={20} /> : <PanelRightOpen size={20} />}
            </button>
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Chat Stream Panel */}
        {/* Removed transition-all to ensure smooth drag resizing */}
        <div 
            className={`flex flex-col bg-white relative border-r border-neutral-200 ${
                isWorkspaceOpen ? 'flex-shrink-0' : 'flex-1'
            }`}
            style={{ width: isWorkspaceOpen ? chatWidth : '100%' }}
        >
          
          {/* Scrollable Logs */}
          <div className="flex-1 overflow-y-auto px-6 pt-6 pb-4">
             <div className="w-full">
                 {/* Task Description */}
                 <div className="mb-8 pb-8 border-b border-neutral-100">
                    <p className="text-sm text-neutral-500 leading-relaxed">{task.description}</p>
                 </div>
                 
                 <LogStream logs={task.logs} />
                 <div ref={bottomRef} className="h-4" />
             </div>
          </div>

          {/* Minimal Input Area */}
          <div className="p-6 pt-4 bg-white flex-shrink-0 w-full z-10 pb-6 border-t border-transparent">
            <div className="relative bg-white rounded-xl border border-neutral-200 shadow-sm hover:shadow-md focus-within:shadow-md focus-within:border-neutral-300 transition-all duration-200">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInput}
                rows={1}
                placeholder="Message Agent..."
                className="w-full px-4 pt-4 pb-2 bg-transparent border-none focus:outline-none resize-none text-sm text-neutral-900 placeholder-neutral-400 leading-relaxed"
                style={{ minHeight: '60px', maxHeight: '300px' }}
              />
              
              {/* Toolbar Row */}
              <div className="flex items-center justify-between px-2 pb-2 pt-1">
                 <div className="flex items-center gap-1">
                     <button className="p-2 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors">
                        <Paperclip size={18} />
                     </button>
                 </div>
                 
                 <div className="flex items-center gap-2">
                     <button 
                       disabled={!input.trim()}
                       className={`p-2 rounded-lg transition-all duration-200 ${
                         input.trim() 
                         ? 'bg-neutral-900 text-white shadow-md hover:bg-black' 
                         : 'bg-transparent text-neutral-300 cursor-not-allowed'
                       }`}
                     >
                       <ArrowUp size={18} />
                     </button>
                 </div>
              </div>
            </div>
            
          </div>
        </div>

        {/* Resizer - Only visible if workspace is open */}
        {isWorkspaceOpen && (
            <div
                className="w-1 cursor-col-resize hover:bg-neutral-200 active:bg-blue-400 transition-colors z-30 -ml-0.5 flex-shrink-0"
                onMouseDown={handleMouseDownResize}
            />
        )}

        {/* Right: Workspace - Takes remaining space */}
        {isWorkspaceOpen && (
            <div className="flex-1 flex flex-col min-w-0 bg-white">
                <WorkspacePanel />
            </div>
        )}

      </div>
    </div>
  );
};