import { CharcoalBreathe, REDUCED_MOTION_GLOBAL } from './LoadingAnimations'

export function FullscreenLoading() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <style>{REDUCED_MOTION_GLOBAL}</style>
      <CharcoalBreathe size="lg" />
    </div>
  )
}
