import React, { useState } from 'react';
import { Task, TaskStatus, Project } from '../types';
import { IconReview, IconRunning, IconPending, IconDone } from './Icons';
import { ChevronDown, ChevronRight, Plus, Layers, Check } from 'lucide-react';
import { PROJECTS } from '../constants';

interface TaskListProps {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  filterProjectId: string | null;
  setFilterProjectId: (id: string | null) => void;
  width?: number;
  onCreateProject?: () => void;
  onCreateTask?: () => void;
}

const TaskGroup = ({ 
  title, 
  tasks, 
  status, 
  defaultOpen, 
  selectedTaskId, 
  onSelectTask 
}: { 
  title: string; 
  tasks: Task[]; 
  status: TaskStatus; 
  defaultOpen: boolean; 
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  if (tasks.length === 0) return null;

  const isReview = status === TaskStatus.Review;

  return (
    <div className="mb-2">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center w-full px-4 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50 transition-colors"
      >
        <span className="mr-2 text-neutral-400">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="flex-1 text-left">{title}</span>
        {isReview ? (
          <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-bold rounded-full animate-hop">
            {tasks.length}
          </span>
        ) : (
          <span className="text-xs text-neutral-400 font-normal">({tasks.length})</span>
        )}
      </button>

      {isOpen && (
        <div className="flex flex-col mt-1">
          {tasks.map(task => {
            const project = PROJECTS.find(p => p.id === task.projectId);
            const isSelected = selectedTaskId === task.id;
            
            return (
              <button
                key={task.id}
                onClick={() => onSelectTask(task.id)}
                className={`flex items-start pl-8 pr-4 py-3 text-sm w-full text-left transition-all border-l-2 group
                  ${isSelected 
                    ? 'bg-neutral-100 border-neutral-800' 
                    : 'border-transparent hover:bg-neutral-50 hover:border-neutral-200'
                  }`}
              >
                <div className={`mt-0.5 mr-3 flex-shrink-0 ${status === TaskStatus.Running ? 'text-blue-600' : 'text-neutral-500'}`}>
                  {status === TaskStatus.Review && <IconReview className={isSelected ? "text-amber-600" : "text-neutral-500"} />}
                  {status === TaskStatus.Running && <IconRunning className="animate-pulse" />}
                  {status === TaskStatus.Pending && <IconPending />}
                  {status === TaskStatus.Done && <IconDone className="text-neutral-400" />}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="mb-0.5">
                    <span className={`font-medium mr-1 ${project?.color || 'text-neutral-500'}`}>
                      {project?.name}
                    </span>
                    <span className="text-neutral-400">/</span>
                    <span className={`ml-1 ${isSelected ? 'text-neutral-900' : 'text-neutral-700'}`}>
                      {task.title}
                    </span>
                  </div>
                  {/* Task Description: visible, 2 lines max */}
                  <p className={`text-xs line-clamp-2 leading-relaxed ${isSelected ? 'text-neutral-500' : 'text-neutral-400 group-hover:text-neutral-500'}`}>
                    {task.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const TaskList: React.FC<TaskListProps> = ({ 
  tasks, 
  selectedTaskId, 
  onSelectTask, 
  filterProjectId, 
  setFilterProjectId, 
  width = 320,
  onCreateProject,
  onCreateTask
}) => {
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const filteredTasks = filterProjectId 
    ? tasks.filter(t => t.projectId === filterProjectId)
    : tasks;

  const currentProject = filterProjectId ? PROJECTS.find(p => p.id === filterProjectId) : null;

  const reviewTasks = filteredTasks.filter(t => t.status === TaskStatus.Review);
  const runningTasks = filteredTasks.filter(t => t.status === TaskStatus.Running);
  const pendingTasks = filteredTasks.filter(t => t.status === TaskStatus.Pending);
  const doneTasks = filteredTasks.filter(t => t.status === TaskStatus.Done);

  return (
    <div 
      className="h-full flex flex-col bg-white border-r border-neutral-200 flex-shrink-0"
      style={{ width }}
    >
      {/* Sidebar Header with Context Switcher */}
      <div className="h-14 flex items-center justify-between px-3 border-b border-neutral-100 flex-shrink-0 relative z-20">
        <div className="relative flex-1 mr-2">
            <button 
                onClick={() => setIsFilterOpen(!isFilterOpen)}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-semibold text-neutral-900 hover:bg-neutral-100 transition-colors w-full text-left group"
            >
                 {filterProjectId && currentProject ? (
                    <>
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${currentProject.color.replace('text-', 'bg-')}`}></span>
                        <span className="truncate">{currentProject.name}</span>
                    </>
                ) : (
                    <>
                        <Layers size={16} className="text-neutral-500 group-hover:text-neutral-800" />
                        <span>All Projects</span>
                    </>
                )}
                <ChevronDown size={14} className={`text-neutral-400 ml-auto transition-transform duration-200 ${isFilterOpen ? 'rotate-180' : ''}`} />
            </button>

             {/* Dropdown Menu */}
             {isFilterOpen && (
                <>
                    {/* Backdrop */}
                    <div className="fixed inset-0 z-30" onClick={() => setIsFilterOpen(false)} />
                    
                    {/* Menu */}
                    <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-neutral-200 rounded-lg shadow-xl shadow-neutral-200/50 z-40 py-1 animate-in fade-in zoom-in-95 duration-100 origin-top-left">
                        <div className="px-3 py-2 text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                            Select View
                        </div>
                        
                        <button
                            onClick={() => { setFilterProjectId(null); setIsFilterOpen(false); }}
                            className="w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-neutral-50 transition-colors group"
                        >
                            <div className="flex items-center gap-2">
                                <div className="w-5 h-5 flex items-center justify-center rounded border border-neutral-200 bg-neutral-50 text-neutral-500 group-hover:border-neutral-300">
                                    <Layers size={12} />
                                </div>
                                <span className={filterProjectId === null ? "text-neutral-900 font-medium" : "text-neutral-600"}>
                                    All Projects
                                </span>
                            </div>
                            {filterProjectId === null && <Check size={14} className="text-neutral-900" />}
                        </button>
                        
                        <div className="h-px bg-neutral-100 my-1 mx-2"></div>
                        
                        {PROJECTS.map(p => {
                            const isActive = filterProjectId === p.id;
                            const bgClass = p.color.replace('text-', 'bg-');
                            
                            return (
                                <button
                                    key={p.id}
                                    onClick={() => { setFilterProjectId(p.id); setIsFilterOpen(false); }}
                                    className="w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-neutral-50 transition-colors"
                                >
                                    <div className="flex items-center gap-2">
                                        <span className={`w-2 h-2 rounded-full ml-1.5 mr-1.5 ${bgClass}`}></span>
                                        <span className={isActive ? "text-neutral-900 font-medium" : "text-neutral-600"}>
                                            {p.name}
                                        </span>
                                    </div>
                                    {isActive && <Check size={14} className="text-neutral-900" />}
                                </button>
                            );
                        })}

                        <div className="h-px bg-neutral-100 my-1 mx-2"></div>

                        {/* Create Project Action */}
                        <button
                            onClick={() => { setIsFilterOpen(false); onCreateProject && onCreateProject(); }}
                            className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 transition-colors"
                        >
                            <Plus size={14} />
                            <span>Create New Project...</span>
                        </button>
                    </div>
                </>
            )}
        </div>

        <button 
          onClick={onCreateTask}
          className="p-1.5 text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors flex-shrink-0" 
          title="New Task"
        >
          <Plus size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        <TaskGroup 
          title="Review" 
          tasks={reviewTasks} 
          status={TaskStatus.Review} 
          defaultOpen={true} 
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
        <TaskGroup 
          title="Running" 
          tasks={runningTasks} 
          status={TaskStatus.Running} 
          defaultOpen={true} 
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
        <TaskGroup 
          title="Pending" 
          tasks={pendingTasks} 
          status={TaskStatus.Pending} 
          defaultOpen={false} 
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
        <TaskGroup 
          title="Done" 
          tasks={doneTasks} 
          status={TaskStatus.Done} 
          defaultOpen={false} 
          selectedTaskId={selectedTaskId}
          onSelectTask={onSelectTask}
        />
      </div>
      
      <div className="p-4 border-t border-neutral-100 text-xs text-neutral-400 flex items-center justify-between">
        <span>{filteredTasks.length} tasks</span>
        {filterProjectId && (
            <button onClick={() => setFilterProjectId(null)} className="hover:text-neutral-800 underline decoration-neutral-300 underline-offset-2">
                Clear filter
            </button>
        )}
      </div>
    </div>
  );
};