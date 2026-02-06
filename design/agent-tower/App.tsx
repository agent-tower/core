import React, { useState, useEffect } from 'react';
import { TaskList } from './components/TaskList';
import { TaskDetail } from './components/TaskDetail';
import { MOCK_TASKS, PROJECTS } from './constants';

export default function App() {
  // State for selected task
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>('t3'); // Default to the running task for demo
  
  // State for project filter
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
  
  // Sidebar resizing state
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [isResizing, setIsResizing] = useState(false);
  
  // Get selected task object
  const selectedTask = MOCK_TASKS.find(t => t.id === selectedTaskId) || null;

  // Handle resizing logic
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      // Limit sidebar width between 240px and 800px
      const newWidth = Math.max(240, Math.min(800, e.clientX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none'; // Prevent text selection while dragging
    } else {
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  return (
    <div className="flex flex-col h-screen bg-neutral-50 overflow-hidden text-sm">
      
      {/* Top Bar: Logo & Workspace Breadcrumbs */}
      <header className="h-12 bg-white border-b border-neutral-200 flex items-center px-4 justify-between flex-shrink-0 z-10 relative">
        <div className="flex items-center gap-4">
           {/* Logo */}
           <div className="flex items-center gap-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-neutral-900">
                <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor"/>
                <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="font-bold text-neutral-900 tracking-tight text-base">Agent Tower</span>
           </div>

           {/* Divider */}
           <div className="h-4 w-px bg-neutral-200 rotate-12"></div>

           {/* Workspace Breadcrumb */}
           <div className="flex items-center gap-2 text-xs">
              <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
              <span className="font-medium text-neutral-600">workspace</span>
              <span className="text-neutral-300">/</span>
              <span className="font-mono font-semibold text-neutral-900">main</span>
           </div>
        </div>

        {/* Right side placeholder (e.g. User Profile) */}
        <div className="w-8 h-8 rounded-full bg-neutral-100 border border-neutral-200 flex items-center justify-center text-xs font-medium text-neutral-500">
          JS
        </div>
      </header>

      {/* Main Layout */}
      <main className="flex-1 flex overflow-hidden">
        <TaskList 
            tasks={MOCK_TASKS} 
            selectedTaskId={selectedTaskId} 
            onSelectTask={setSelectedTaskId}
            filterProjectId={filterProjectId}
            setFilterProjectId={setFilterProjectId}
            width={sidebarWidth}
        />
        
        {/* Resizer Handle */}
        <div
            className="w-1 cursor-col-resize hover:bg-neutral-300 active:bg-neutral-400 transition-colors z-50 -ml-[2px] flex-shrink-0 h-full"
            onMouseDown={() => setIsResizing(true)}
            title="Drag to resize"
        />
        
        <TaskDetail task={selectedTask} />
      </main>
    </div>
  );
}