import React from 'react';

export const IconReview = ({ className }: { className?: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1z" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 1a7 7 0 0 0 0 14V1z" fill="currentColor" />
  </svg>
);

export const IconRunning = ({ className }: { className?: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
    <circle cx="8" cy="8" r="3" fill="currentColor" />
  </svg>
);

export const IconPending = ({ className }: { className?: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

export const IconDone = ({ className }: { className?: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
    <path d="M13.5 4.5L6.5 11.5L2.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export const IconAgentAction = ({ className }: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
    <path d="M7 0L14 7L7 14L0 7L7 0Z" />
  </svg>
);

export const IconAgentInfo = ({ className }: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} xmlns="http://www.w3.org/2000/svg">
    <path d="M7 1L13 7L7 13L1 7L7 1Z" />
  </svg>
);

export const IconTool = ({ className }: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
    <path d="M4 2L11 7L4 12V2Z" />
  </svg>
);

export const IconToolExpanded = ({ className }: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
    <path d="M2 4L7 11L12 4H2Z" />
  </svg>
);

export const IconCursor = ({ className }: { className?: string }) => (
  <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
    <rect width="10" height="16" />
  </svg>
);