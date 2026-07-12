import { cn } from '@/lib/utils'

function compact(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const k = value / 1000
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`
  }
  const m = value / 1_000_000
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}m`
}

/** Compact "+N −M" diff-stat chip. Green additions / red deletions. */
export function DiffStatLabel({
  additions,
  deletions,
  className,
}: {
  additions: number
  deletions: number
  className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono tabular-nums', className)}>
      <span className="text-success">+{compact(additions)}</span>
      <span className="text-destructive">−{compact(deletions)}</span>
    </span>
  )
}
