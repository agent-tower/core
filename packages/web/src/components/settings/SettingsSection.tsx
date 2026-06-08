import { cn } from '@/lib/utils'

export function SettingsPageContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-4xl px-5 py-5 sm:px-8 sm:py-6', className)}>
      {children}
    </div>
  )
}

interface SettingsFieldProps {
  label: string
  description?: string
  children: React.ReactNode
  className?: string
  htmlFor?: string
}

export function SettingsField({ label, description, children, className, htmlFor }: SettingsFieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div>
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-neutral-700">{label}</label>
        {description && (
          <p className="text-[11px] leading-relaxed text-neutral-400">{description}</p>
        )}
      </div>
      {children}
    </div>
  )
}
