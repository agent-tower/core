import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, action }) => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true);
      document.body.style.overflow = 'hidden';
    } else {
      const timer = setTimeout(() => setIsVisible(false), 200);
      document.body.style.overflow = 'unset';
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isVisible && !isOpen) return null;

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ${isOpen ? 'opacity-100' : 'opacity-0'}`}>
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-white/80 backdrop-blur-sm" 
        onClick={onClose}
      />

      {/* Content */}
      <div className={`relative w-full max-w-lg bg-white rounded-xl shadow-2xl shadow-neutral-200/50 border border-neutral-100 transform transition-all duration-200 ${isOpen ? 'scale-100 translate-y-0' : 'scale-95 translate-y-2'}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-50">
          <h3 className="font-semibold text-neutral-900">{title}</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-900 transition-colors">
            <X size={18} />
          </button>
        </div>
        
        <div className="p-6">
          {children}
        </div>

        {action && (
          <div className="px-6 py-4 bg-neutral-50 rounded-b-xl border-t border-neutral-100 flex justify-end gap-3">
            {action}
          </div>
        )}
      </div>
    </div>
  );
};