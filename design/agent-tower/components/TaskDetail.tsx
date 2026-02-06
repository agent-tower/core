import React, { useState, useEffect, useRef } from 'react';
import { Task, TaskStatus } from '../types';
import { PROJECTS } from '../constants';
import { IconRunning, IconReview, IconDone, IconPending } from './Icons';
import { LogStream } from './LogStream';
import { Send, Square, Paperclip, AtSign, Hash, Globe, CheckCircle2, XCircle, ChevronDown, ChevronUp } from 'lucide-react';

interface TaskDetailProps {
  task: Task | null;
}

export const TaskDetail: React.FC<TaskDetailProps> = ({ task }) => {
  const [input, setInput] = useState('');
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [task?.logs]);

  // Handle textarea auto-resize
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'; // Reset height
      // Max height approx 8 lines (24px line-height * 8 + padding) ~ 210px
      const maxHeight = 210; 
      const newHeight = Math.min(textareaRef.current.scrollHeight, maxHeight);
      textareaRef.current.style.height = `${newHeight}px`;
    }
  };

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white text-neutral-400">
        <p>Select a task to view details</p>
      </div>
    );
  }

  const project = PROJECTS.find(p => p.id === task.projectId);
  const isReview = task.status === TaskStatus.Review;

  return (
    <div className="flex-1 flex flex-col h-full bg-white relative">
      {/* Header */}
      <div className="px-8 py-5 border-b border-neutral-100 bg-white transition-all duration-300">
        
        {/* Row 1: Title & Status */}
        <div className="flex items-center flex-wrap gap-3">
          <div className="flex items-baseline gap-2">
             <span className={`text-base font-medium ${project?.color || 'text-neutral-500'}`}>
               {project?.name}
             </span>
             <span className="text-neutral-300 text-sm">/</span>
             <span className="text-xl font-bold text-neutral-900 tracking-tight">
               {task.title}
             </span>
          </div>

          {/* Status Indicators - Compact & Inline */}
          <div className="flex items-center">
             {task.status === TaskStatus.Running && (
                <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs font-medium border border-blue-100">
                  <IconRunning className="w-3.5 h-3.5 animate-pulse" />
                  <span>Running</span>
                </div>
             )}
             {isReview && (
                <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-amber-50 text-amber-700 rounded-full text-xs font-medium border border-amber-100">
                  <IconReview className="w-3.5 h-3.5" />
                  <span>Review</span>
                </div>
             )}
              {task.status === TaskStatus.Done && (
                <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-emerald-50 text-emerald-700 rounded-full text-xs font-medium border border-emerald-100">
                  <IconDone className="w-3.5 h-3.5" />
                  <span>Done</span>
                </div>
             )}
             {task.status === TaskStatus.Pending && (
                <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-neutral-100 text-neutral-600 rounded-full text-xs font-medium border border-neutral-200">
                  <IconPending className="w-3.5 h-3.5" />
                  <span>Pending</span>
                </div>
             )}
          </div>
        </div>

        {/* Row 2: Description */}
        <div className="mt-1.5 flex items-start gap-2 group max-w-4xl">
          <div 
            className={`text-sm text-neutral-600 leading-relaxed cursor-pointer transition-all ${isDescriptionExpanded ? '' : 'truncate'}`}
            onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
          >
            {task.description}
          </div>
          <button 
            onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
            className="mt-0.5 text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-neutral-600 transition-opacity"
          >
            {isDescriptionExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>

        {/* Row 3: Meta Info (Agent & Branch) */}
        <div className="flex items-center gap-6 mt-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-neutral-400 font-medium">Agent</span>
            <div className="flex items-center gap-1.5 text-neutral-900 font-medium bg-neutral-50 px-2 py-1 rounded border border-neutral-100">
               {task.agent}
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-neutral-400 font-medium">Branch</span>
            <div className="flex items-center gap-1.5 text-neutral-700 font-mono bg-neutral-50 px-2 py-1 rounded border border-neutral-100">
               {task.branch}
            </div>
          </div>
        </div>

      </div>

      {/* Main Content Area (Logs) */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="min-h-[200px]">
          <LogStream logs={task.logs} />
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Review Action Banner */}
      {isReview && (
        <div className="px-8 py-4 bg-amber-50 border-t border-amber-100 flex items-center justify-between animate-in slide-in-from-bottom-2 duration-300">
            <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 bg-amber-100 text-amber-600 rounded-full">
                    <IconReview />
                </div>
                <div>
                    <div className="text-sm font-semibold text-amber-900">Waiting for Review</div>
                    <div className="text-xs text-amber-700/70">Verify the changes before proceeding</div>
                </div>
            </div>
            <div className="flex items-center gap-3">
                <button className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-neutral-600 bg-white border border-neutral-200 hover:bg-neutral-50 hover:text-neutral-900 rounded-lg transition-colors">
                    <XCircle size={14} />
                    <span>Request Changes</span>
                </button>
                <button className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-neutral-900 hover:bg-black rounded-lg shadow-sm transition-colors">
                    <CheckCircle2 size={14} />
                    <span>Approve</span>
                </button>
            </div>
        </div>
      )}

      {/* Input Area */}
      <div className={`px-8 py-6 border-t ${isReview ? 'border-amber-100' : 'border-neutral-100'} bg-white`}>
        <div className={`relative border rounded-xl shadow-sm bg-white focus-within:ring-1 transition-all duration-200 ${
            isReview 
            ? 'border-amber-200 focus-within:ring-amber-200 focus-within:border-amber-300' 
            : 'border-neutral-200 focus-within:ring-neutral-300 focus-within:border-neutral-300'
        }`}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            rows={3}
            placeholder={isReview ? "Add comments to your review..." : "Type a message to the agent..."}
            className="w-full px-4 py-3 bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-neutral-900 placeholder-neutral-400 leading-relaxed text-sm scrollbar-thin scrollbar-thumb-neutral-200 scrollbar-track-transparent"
            style={{ minHeight: '80px', maxHeight: '210px' }}
          />
          
          <div className="flex items-center justify-between px-3 pb-3 pt-1 border-t border-transparent">
            {/* Left Toolbar */}
            <div className="flex items-center gap-1 text-neutral-400">
               <button className="p-2 hover:bg-neutral-100 hover:text-neutral-600 rounded-lg transition-colors" title="Attach File">
                 <Paperclip size={18} />
               </button>
               <button className="p-2 hover:bg-neutral-100 hover:text-neutral-600 rounded-lg transition-colors" title="Mention">
                 <AtSign size={18} />
               </button>
               <button className="p-2 hover:bg-neutral-100 hover:text-neutral-600 rounded-lg transition-colors" title="Reference Issue">
                 <Hash size={18} />
               </button>
               <div className="w-px h-4 bg-neutral-200 mx-1"></div>
               <button className="p-2 hover:bg-neutral-100 hover:text-neutral-600 rounded-lg transition-colors" title="Search Web">
                 <Globe size={18} />
               </button>
            </div>

            {/* Right Actions */}
            <div className="flex items-center gap-2">
               {task.status === TaskStatus.Running && (
                  <button className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors">
                    <Square size={12} fill="currentColor" />
                    <span>Stop</span>
                  </button>
               )}
               <button 
                 disabled={!input.trim()}
                 className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg transition-all ${
                   input.trim() 
                   ? 'bg-neutral-900 text-white hover:bg-black shadow-sm' 
                   : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                 }`}
               >
                 <span>Send</span>
                 <Send size={14} />
               </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};