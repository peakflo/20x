import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium leading-tight transition-colors',
  {
    variants: {
      variant: {
        default: 'border-border/50 bg-muted text-muted-foreground',
        blue: 'border-blue-500/20 bg-blue-500/10 text-blue-400',
        green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
        yellow: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
        red: 'border-red-500/20 bg-red-500/10 text-red-400',
        purple: 'border-purple-500/20 bg-purple-500/10 text-purple-400',
        orange: 'border-orange-500/20 bg-orange-500/10 text-orange-400'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
