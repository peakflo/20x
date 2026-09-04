import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { CheckSquare, CornerDownLeft } from 'lucide-react'
import type { WorkfloTask } from '@/types'

interface SubtaskPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subtasks: WorkfloTask[]
  onSelect: (taskId: string) => void
}

export function SubtaskPickerDialog({ open, onOpenChange, subtasks, onSelect }: SubtaskPickerDialogProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setActiveIndex(0)
  }, [open])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const select = (taskId: string) => {
    onOpenChange(false)
    onSelect(taskId)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const key = event.key.toLowerCase()
    if (event.key === 'ArrowDown' || key === 'j') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, subtasks.length - 1))
    } else if (event.key === 'ArrowUp' || key === 'k') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const subtask = subtasks[activeIndex]
      if (subtask) select(subtask.id)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className="fixed left-1/2 top-[24%] z-50 w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl outline-none"
        >
          <DialogPrimitive.Title className="border-b border-border/60 px-4 py-3 text-sm font-semibold">
            Open subtask
          </DialogPrimitive.Title>
          <div ref={listRef} role="listbox" aria-label="Subtasks" className="max-h-[360px] overflow-y-auto p-2">
            {subtasks.map((subtask, index) => (
              <button
                key={subtask.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(subtask.id)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
                  index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
              >
                <CheckSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{subtask.title}</span>
                {index === activeIndex && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
            <span>Use ↑/↓ or J/K to select</span>
            <span>Enter to open · Esc to close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
