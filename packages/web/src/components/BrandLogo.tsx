import logoUrl from '@/assets/agent-tower-logo.png'

interface BrandLogoProps {
  className?: string
}

export function BrandLogo({ className = 'h-7 w-7' }: BrandLogoProps) {
  return (
    <img
      src={logoUrl}
      alt="Agent Tower"
      className={`block shrink-0 object-contain ${className}`}
    />
  )
}
