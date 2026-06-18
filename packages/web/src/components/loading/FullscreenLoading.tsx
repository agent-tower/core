import { CharcoalBreathe, REDUCED_MOTION_GLOBAL } from './LoadingAnimations'
import { useDesktopTitlebar } from '@/lib/desktop-titlebar'

export function FullscreenLoading() {
  const { usesIntegratedTitlebar } = useDesktopTitlebar()

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-background ${usesIntegratedTitlebar ? 'app-region-drag' : ''}`}>
      <style>{REDUCED_MOTION_GLOBAL}</style>
      <CharcoalBreathe size="lg" />
    </div>
  )
}
