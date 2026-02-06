import React, { useState } from 'react';
import { Terminal, Code2, Globe, GitGraph, FileCode, Play, RotateCw, Plus, X, Trash2, Copy, MoreHorizontal, CornerDownLeft } from 'lucide-react';

type Tab = 'code' | 'terminal' | 'preview' | 'git';

interface TerminalInstance {
    id: string;
    title: string;
    status: 'running' | 'idle';
    command?: string;
}

export const WorkspacePanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('code');
  
  // Terminal State
  const [terminals, setTerminals] = useState<TerminalInstance[]>([
      { id: '1', title: 'npm run dev', status: 'running', command: 'vite v5.1.4' },
      { id: '2', title: 'agent-exec', status: 'idle' }
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState<string>('1');

  const addTerminal = () => {
      const newId = Date.now().toString();
      const newTerminal: TerminalInstance = { id: newId, title: 'bash', status: 'idle' };
      setTerminals([...terminals, newTerminal]);
      setActiveTerminalId(newId);
  };

  const removeTerminal = (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const newTerminals = terminals.filter(t => t.id !== id);
      setTerminals(newTerminals);
      if (activeTerminalId === id && newTerminals.length > 0) {
          setActiveTerminalId(newTerminals[0].id);
      }
  };

  const activeTerminal = terminals.find(t => t.id === activeTerminalId) || terminals[0];

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Workspace Tabs - Folder Style */}
      <div className="flex items-center px-2 pt-2 border-b border-neutral-200 bg-neutral-100/80 flex-shrink-0 gap-1 select-none">
        <TabButton 
          active={activeTab === 'code'} 
          onClick={() => setActiveTab('code')} 
          icon={<Code2 size={14} />} 
          label="Editor" 
        />
        <TabButton 
          active={activeTab === 'terminal'} 
          onClick={() => setActiveTab('terminal')} 
          icon={<Terminal size={14} />} 
          label="Terminal" 
        />
        <TabButton 
          active={activeTab === 'preview'} 
          onClick={() => setActiveTab('preview')} 
          icon={<Globe size={14} />} 
          label="Preview" 
        />
        <TabButton 
          active={activeTab === 'git'} 
          onClick={() => setActiveTab('git')} 
          icon={<GitGraph size={14} />} 
          label="Changes" 
        />
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden relative">
        
        {/* Editor View - Visual Polish */}
        {activeTab === 'code' && (
          <div className="flex h-full flex-col animate-in fade-in duration-200">
            {/* File Context Header */}
            <div className="h-10 flex items-center justify-between px-4 border-b border-neutral-100 bg-white/50 backdrop-blur-sm z-10">
                <div className="flex items-center gap-2 text-sm">
                    <FileCode size={15} className="text-neutral-400" />
                    <div className="flex items-baseline gap-1 text-neutral-500">
                        <span className="opacity-60">src/auth/</span>
                        <span className="font-semibold text-neutral-800">Login.tsx</span>
                    </div>
                    {/* Status Dot - cleaner than text */}
                    <div className="ml-2 w-1.5 h-1.5 rounded-full bg-amber-500 ring-2 ring-amber-100" title="Modified by Agent"></div>
                </div>
                <div className="flex items-center gap-1">
                    <button className="p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-md transition-colors" title="Copy Content">
                        <Copy size={14} />
                    </button>
                    <button className="p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-md transition-colors">
                        <MoreHorizontal size={14} />
                    </button>
                </div>
            </div>

            {/* Code Content */}
            <div className="flex-1 overflow-auto bg-white font-mono text-[13px] leading-7 text-neutral-800">
                <div className="py-4">
                    
                    {/* Standard Lines */}
                    <CodeLine num={1}>
                        <span className="text-purple-600">import</span> React, {'{'} useState {'}'} <span className="text-purple-600">from</span> <span className="text-teal-600">'react'</span>;
                    </CodeLine>
                    <CodeLine num={2}>
                        <span className="text-purple-600">import</span> {'{'} Button {'}'} <span className="text-purple-600">from</span> <span className="text-teal-600">'../ui/button'</span>;
                    </CodeLine>
                    <CodeLine num={3} />
                    
                    <CodeLine num={4}>
                        <span className="text-purple-600">export const</span> <span className="text-blue-600">LoginForm</span> = () ={'>'} {'{'}
                    </CodeLine>
                    <CodeLine num={5}>
                        &nbsp;&nbsp;<span className="text-purple-600">const</span> [isLoading, setIsLoading] = useState(<span className="text-blue-600">false</span>);
                    </CodeLine>
                    <CodeLine num={6} />
                    
                    {/* Context/Comment */}
                    <CodeLine num={7}>
                        &nbsp;&nbsp;<span className="text-neutral-400 italic font-normal">// TODO: Implement OAuth providers</span>
                    </CodeLine>
                    <CodeLine num={8}>
                        &nbsp;&nbsp;<span className="text-purple-600">return</span> (
                    </CodeLine>
                    <CodeLine num={9}>
                        &nbsp;&nbsp;&nbsp;&nbsp;&lt;<span className="text-rose-600">div</span> className=<span className="text-teal-600">"p-4 space-y-4"</span>&gt;
                    </CodeLine>

                    {/* Agent Modification Block - visually highlighted */}
                    <div className="group relative">
                        <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500"></div>
                        <div className="bg-blue-50/40">
                            <CodeLine num={10} isModified>
                                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&lt;<span className="text-rose-600">h1</span>&gt;Login to Agent Tower&lt;/<span className="text-rose-600">h1</span>&gt;
                            </CodeLine>
                            <CodeLine num={11} isModified>
                                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&lt;<span className="text-rose-600">p</span> className=<span className="text-teal-600">"text-sm text-gray-500"</span>&gt;Please verify...&lt;/<span className="text-rose-600">p</span>&gt;
                            </CodeLine>
                        </div>
                        {/* Floating Action for the diff block */}
                        <div className="absolute right-4 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-white shadow-sm border border-neutral-200 rounded px-2 py-1 text-[10px] text-neutral-500 flex items-center gap-1 cursor-pointer hover:text-blue-600 hover:border-blue-200">
                             <CornerDownLeft size={10} />
                             <span>Revert</span>
                        </div>
                    </div>

                    <CodeLine num={12}>
                        &nbsp;&nbsp;&nbsp;&nbsp;&lt;/<span className="text-rose-600">div</span>&gt;
                    </CodeLine>
                    <CodeLine num={13}>
                        &nbsp;&nbsp;);
                    </CodeLine>
                    <CodeLine num={14}>
                        {'}'};
                    </CodeLine>
                </div>
            </div>
          </div>
        )}

        {/* Terminal View */}
        {activeTab === 'terminal' && (
          <div className="flex h-full flex-col bg-[#1e1e1e] text-neutral-200 font-mono text-xs animate-in fade-in duration-200">
             {/* Terminal Header/Tabs */}
             <div className="flex items-center bg-[#252526] border-b border-[#333] px-2 pt-2 gap-1 overflow-x-auto">
                {terminals.map(t => (
                    <button
                        key={t.id}
                        onClick={() => setActiveTerminalId(t.id)}
                        className={`group flex items-center gap-2 px-3 py-2 rounded-t-md min-w-[120px] max-w-[200px] border-t border-x ${
                            activeTerminalId === t.id 
                            ? 'bg-[#1e1e1e] border-[#1e1e1e] text-white' 
                            : 'bg-[#2d2d2d] border-transparent text-neutral-500 hover:bg-[#333] hover:text-neutral-300'
                        }`}
                    >
                        <span className={`w-2 h-2 rounded-full ${t.status === 'running' ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-500'}`}></span>
                        <span className="truncate flex-1 text-left">{t.title}</span>
                        <span 
                            onClick={(e) => removeTerminal(t.id, e)}
                            className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-neutral-700 rounded transition-all"
                        >
                            <X size={10} />
                        </span>
                    </button>
                ))}
                <button 
                    onClick={addTerminal}
                    className="p-1.5 mb-0.5 text-neutral-500 hover:text-neutral-300 hover:bg-[#333] rounded ml-1"
                >
                    <Plus size={14} />
                </button>
             </div>

             {/* Terminal Body */}
             <div className="flex-1 flex flex-col p-4 space-y-1 overflow-auto">
                {activeTerminal ? (
                    <>
                        <div className="text-neutral-500 mb-4 select-none">
                            Last login: {new Date().toLocaleTimeString()} on ttys001
                        </div>
                        {activeTerminal.status === 'running' ? (
                            <>
                                <div className="flex gap-2">
                                    <span className="text-emerald-500">➜</span>
                                    <span className="text-blue-400">~/project</span>
                                    <span className="text-neutral-300">{activeTerminal.id === '1' ? 'npm run dev' : 'bash'}</span>
                                </div>
                                {activeTerminal.command && (
                                    <div className="text-neutral-400 pt-1">
                                        > agent-tower@0.1.0 dev<br/>
                                        > {activeTerminal.command}
                                    </div>
                                )}
                                {activeTerminal.id === '1' && (
                                    <>
                                        <div className="pt-2">
                                            <span className="text-emerald-500">VITE v5.1.4</span> <span className="text-green-300">ready in 240 ms</span>
                                        </div>
                                        <div className="pt-1 text-neutral-400">
                                            ➜  Local:   <span className="text-blue-400 underline">http://localhost:5173/</span><br/>
                                            ➜  Network: use --host to expose
                                        </div>
                                    </>
                                )}
                                <div className="pt-4 flex gap-2 animate-pulse">
                                    <span className="text-emerald-500">➜</span>
                                    <span className="text-blue-400">~/project</span>
                                    <span className="w-1.5 h-4 bg-neutral-400 block"></span>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="flex gap-2">
                                    <span className="text-emerald-500">➜</span>
                                    <span className="text-blue-400">~/project</span>
                                    <span className="w-1.5 h-4 bg-neutral-400 block animate-pulse"></span>
                                </div>
                            </>
                        )}
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-neutral-600 flex-col gap-2">
                        <Terminal size={32} />
                        <span>No open terminals</span>
                        <button onClick={addTerminal} className="text-blue-400 hover:underline text-xs">Create new terminal</button>
                    </div>
                )}
             </div>
          </div>
        )}

        {/* Browser Preview */}
        {activeTab === 'preview' && (
          <div className="flex h-full flex-col bg-neutral-100 animate-in fade-in duration-200">
             <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-neutral-200">
                <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-400"></div>
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-400"></div>
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-400"></div>
                </div>
                <div className="flex-1 flex items-center gap-2 bg-neutral-100 px-3 py-1 rounded text-xs text-neutral-500 mx-2">
                    <Globe size={10} />
                    <span>localhost:5173</span>
                </div>
                <button className="text-neutral-400 hover:text-neutral-600"><RotateCw size={12} /></button>
             </div>
             <div className="flex-1 flex items-center justify-center p-8">
                <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-neutral-200 p-8 text-center">
                    <div className="w-12 h-12 bg-neutral-900 rounded-lg mx-auto mb-4 flex items-center justify-center text-white font-bold">AT</div>
                    <h1 className="text-2xl font-bold text-neutral-900 mb-2">Login to Agent Tower</h1>
                    <p className="text-neutral-500 text-sm mb-6">Welcome back, please enter your details.</p>
                    <div className="space-y-3">
                        <div className="h-9 bg-neutral-100 rounded border border-neutral-200"></div>
                        <div className="h-9 bg-neutral-100 rounded border border-neutral-200"></div>
                        <div className="h-9 bg-neutral-900 rounded text-white flex items-center justify-center text-sm font-medium">Sign In</div>
                    </div>
                </div>
             </div>
          </div>
        )}

        {/* Git Changes */}
        {activeTab === 'git' && (
          <div className="flex h-full flex-col bg-white animate-in fade-in duration-200">
             <div className="px-4 py-3 border-b border-neutral-100">
                <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-neutral-900">Source Control</h3>
                    <div className="flex gap-2">
                        <span className="text-xs bg-neutral-100 px-1.5 py-0.5 rounded text-neutral-500">main</span>
                    </div>
                </div>
                <div className="relative">
                    <input type="text" placeholder="Message (Enter to commit)" className="w-full px-3 py-1.5 bg-neutral-50 border border-neutral-200 rounded text-xs focus:outline-none focus:border-neutral-400" />
                </div>
             </div>
             <div className="flex-1 overflow-auto p-2">
                <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider px-2 py-2">Changes</div>
                <div className="space-y-0.5">
                    <FileItem name="src/auth/Login.tsx" status="M" color="text-amber-600" />
                    <FileItem name="src/components/Button.tsx" status="M" color="text-amber-600" />
                    <FileItem name="src/utils/validation.ts" status="U" color="text-emerald-600" />
                    <FileItem name="package.json" status="M" color="text-amber-600" />
                </div>
             </div>
          </div>
        )}
      </div>
    </div>
  );
};

// --- Helper Components for Visual Cleanliness ---

const TabButton = ({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-2 px-4 py-2 text-xs font-medium transition-all rounded-t-md border-t border-x -mb-px relative top-px ${
      active 
      ? 'bg-white border-neutral-200 text-neutral-900 shadow-[0_-2px_6px_rgba(0,0,0,0.02)] z-10' 
      : 'bg-transparent border-transparent text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50'
    }`}
  >
    {icon}
    <span>{label}</span>
  </button>
);

const CodeLine = ({ num, children, isModified }: { num: number; children?: React.ReactNode; isModified?: boolean }) => (
    <div className={`flex gap-4 px-4 hover:bg-neutral-50/80 transition-colors ${isModified ? 'text-neutral-900' : ''}`}>
        <div className={`text-[10px] select-none text-right min-w-[24px] pt-[2px] ${isModified ? 'text-blue-400 font-medium' : 'text-neutral-300'}`}>
            {num}
        </div>
        <div className="flex-1 whitespace-pre">{children || ' '}</div>
    </div>
);

const FileItem = ({ name, status, color }: { name: string; status: string; color: string }) => (
    <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-neutral-50 rounded cursor-pointer group">
        <span className={`w-4 h-4 flex items-center justify-center text-[10px] font-bold border border-neutral-100 rounded-sm ${color}`}>
            {status}
        </span>
        <span className="text-xs text-neutral-700 group-hover:text-neutral-900 truncate flex-1">{name}</span>
    </div>
)
