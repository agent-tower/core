export type DesktopDataMode = 'isolated' | 'shared';

export interface DesktopDataModeOptions {
  envMode?: string;
  isPackaged: boolean;
}

export function resolveDesktopDataMode({ envMode, isPackaged }: DesktopDataModeOptions): DesktopDataMode {
  if (envMode === 'isolated' || envMode === 'shared') {
    return envMode;
  }

  return isPackaged ? 'shared' : 'isolated';
}
