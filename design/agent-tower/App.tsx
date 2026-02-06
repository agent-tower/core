import React, { useState, useEffect } from 'react';
import { TaskList } from './components/TaskList';
import { TaskDetail } from './components/TaskDetail';
import { Modal } from './components/Modal';
import { MOCK_TASKS, PROJECTS } from './constants';
import { ChevronDown, Plus } from 'lucide-react';

export default function App() {
  // State for selected task
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>('t3');
  
  // State for project filter
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
  
  // Sidebar resizing state
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [isResizing, setIsResizing] = useState(false);

  // Modal States
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);

  // Form States (Mock)
  const [newProjectColor, setNewProjectColor] = useState('text-indigo-600');
  
  // Get selected task object
  const selectedTask = MOCK_TASKS.find(t => t.id === selectedTaskId) || null;

  // Handle task toggle logic
  const handleTaskSelect = (id: string) => {
    if (selectedTaskId === id) {
      setSelectedTaskId(null);
    } else {
      setSelectedTaskId(id);
    }
  };

  // Handle resizing logic
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
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

  const COLORS = [
    'text-indigo-600', 'text-emerald-600', 'text-rose-600', 
    'text-amber-600', 'text-blue-600', 'text-purple-600', 'text-neutral-600'
  ];

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

        <div className="w-8 h-8 rounded-full bg-neutral-100 border border-neutral-200 flex items-center justify-center text-xs font-medium text-neutral-500">
          JS
        </div>
      </header>

      {/* Main Layout */}
      <main className="flex-1 flex overflow-hidden">
        <TaskList 
            tasks={MOCK_TASKS} 
            selectedTaskId={selectedTaskId} 
            onSelectTask={handleTaskSelect}
            filterProjectId={filterProjectId}
            setFilterProjectId={setFilterProjectId}
            width={sidebarWidth}
            onCreateProject={() => setIsProjectModalOpen(true)}
            onCreateTask={() => setIsTaskModalOpen(true)}
        />
        
        <div
            className="w-1 cursor-col-resize hover:bg-neutral-300 active:bg-neutral-400 transition-colors z-50 -ml-[2px] flex-shrink-0 h-full"
            onMouseDown={() => setIsResizing(true)}
            title="Drag to resize"
        />
        
        <TaskDetail task={selectedTask} />
      </main>

      {/* Create Project Modal */}
      <Modal 
        isOpen={isProjectModalOpen} 
        onClose={() => setIsProjectModalOpen(false)}
        title="Create New Project"
        action={
          <>
            <button onClick={() => setIsProjectModalOpen(false)} className="px-4 py-2 text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors font-medium">Cancel</button>
            <button onClick={() => setIsProjectModalOpen(false)} className="px-4 py-2 bg-neutral-900 text-white rounded-lg hover:bg-black transition-colors font-medium">Create Project</button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1.5">Project Name</label>
            <input type="text" placeholder="e.g. Mobile App" className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-200 focus:bg-white transition-all text-neutral-900" autoFocus />
          </div>
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">Color Tag</label>
            <div className="flex items-center gap-3">
              {COLORS.map(color => (
                <button 
                  key={color}
                  onClick={() => setNewProjectColor(color)}
                  className={`w-6 h-6 rounded-full transition-all ${color.replace('text-', 'bg-')} ${newProjectColor === color ? 'ring-2 ring-offset-2 ring-neutral-400 scale-110' : 'hover:scale-110 opacity-70 hover:opacity-100'}`}
                />
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Create Task Modal */}
      <Modal 
        isOpen={isTaskModalOpen} 
        onClose={() => setIsTaskModalOpen(false)}
        title="Brief New Agent Task"
        action={
          <>
             <button onClick={() => setIsTaskModalOpen(false)} className="px-4 py-2 text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors font-medium">Cancel</button>
             <button onClick={() => setIsTaskModalOpen(false)} className="flex items-center gap-2 px-4 py-2 bg-neutral-900 text-white rounded-lg hover:bg-black transition-colors font-medium">
                <Plus size={16} />
                <span>Initialize Task</span>
             </button>
          </>
        }
      >
        <div className="space-y-5">
           {/* Context Pills */}
           <div className="flex flex-wrap gap-2">
              <div className="relative group">
                <select className="appearance-none pl-3 pr-8 py-1.5 bg-neutral-50 border border-neutral-200 rounded-md text-xs font-medium text-neutral-700 hover:border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-100 cursor-pointer">
                  {PROJECTS.map(p => <option key={p.id}>{p.name}</option>)}
                </select>
                <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
              </div>
              
              <div className="relative group">
                <select className="appearance-none pl-3 pr-8 py-1.5 bg-neutral-50 border border-neutral-200 rounded-md text-xs font-medium text-neutral-700 hover:border-neutral-300 focus:outline-none focus:ring-2 focus:ring-neutral-100 cursor-pointer">
                  <option>Claude Code</option>
                  <option>GPT-4o</option>
                  <option>Gemini 2.0</option>
                </select>
                <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
              </div>

               <div className="relative group">
                <div className="flex items-center gap-1 pl-3 pr-3 py-1.5 bg-neutral-50 border border-neutral-200 rounded-md text-xs font-mono text-neutral-500 cursor-not-allowed select-none">
                  <span>feat/new-task-xyz</span>
                </div>
              </div>
           </div>

          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1.5">Task Title</label>
            <input type="text" placeholder="What needs to be done?" className="w-full px-3 py-2 text-lg font-medium bg-transparent border-b border-neutral-200 focus:border-neutral-900 focus:outline-none transition-colors placeholder-neutral-300" autoFocus />
          </div>

          <div>
             <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1.5">Description / Prompt</label>
             <textarea 
                rows={4} 
                className="w-full px-3 py-2 bg-neutral-50 border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-200 focus:bg-white transition-all text-neutral-900 text-sm leading-relaxed resize-none"
                placeholder="Describe the requirements in detail. You can paste code snippets or context here..."
              />
          </div>
        </div>
      </Modal>

    </div>
  );
}