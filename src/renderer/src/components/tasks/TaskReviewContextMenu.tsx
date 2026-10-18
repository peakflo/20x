import { useEffect, useRef } from 'react'
import { CheckCheck, Mail } from 'lucide-react'

interface TaskReviewContextMenuProps {
  x: number
  y: number
  /** Whether the task is currently unseen — picks which action is offered. */
  unseen: boolean
  onMarkSeen: () => void
  onMarkUnseen: () => void
  onClose: () => void
}

const MENU_WIDTH = 200
const MENU_HEIGHT = 48

/** Right-click menu on a task row in review: flip its seen state. */
export function TaskReviewContextMenu({ x, y, unseen, onMarkSeen, onMarkUnseen, onClose }: TaskReviewContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointer = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Deferred so the opening right-click does not immediately close it.
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handlePointer)
      document.addEventListener('keydown', handleKey)
      window.addEventListener('blur', onClose)
      window.addEventListener('resize', onClose)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const Icon = unseen ? CheckCheck : Mail
  const label = unseen ? 'Mark as seen' : 'Mark as unseen'

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[9999] min-w-[180px] glass-popover border rounded-xl overflow-hidden py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8))
      }}
    >
      <button
        type="button"
        role="menuitem"
        autoFocus
        onClick={() => {
          if (unseen) onMarkSeen()
          else onMarkUnseen()
          onClose()
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent/50 focus:bg-accent/50 focus:outline-none cursor-pointer"
      >
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        {label}
      </button>
    </div>
  )
}
