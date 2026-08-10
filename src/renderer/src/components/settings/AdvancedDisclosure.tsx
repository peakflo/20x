import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface AdvancedDisclosureProps {
  label: string
  /** Open on first paint. The caller restores the user's last choice. */
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
  'data-testid'?: string
}

/**
 * A show-and-hide for the settings that already have a good default.
 *
 * It is deliberately not a switch. A switch says "this setting is on or off",
 * and nothing here is being switched on: the controls exist either way, and
 * this only decides whether they are on screen.
 */
export function AdvancedDisclosure({
  label,
  defaultOpen = false,
  onOpenChange,
  children,
  'data-testid': testId,
}: AdvancedDisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    onOpenChange?.(next)
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        data-testid={testId}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>

      {open && <div className="space-y-3">{children}</div>}
    </div>
  )
}
