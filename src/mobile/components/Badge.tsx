import { BADGE_VARIANTS, type BadgeVariant } from '../lib/utils'

interface BadgeProps {
  variant?: BadgeVariant
  className?: string
  children: React.ReactNode
}

export function Badge({ variant = 'default', className = '', children }: BadgeProps) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium leading-tight transition-colors ${BADGE_VARIANTS[variant]} ${className}`}>
      {children}
    </span>
  )
}
