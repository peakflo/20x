import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bot, Check, ChevronDown, ExternalLink, FolderOpen, Layers, Menu, MoreHorizontal, Pencil, Play, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { TaskPriorityBadge } from './TaskPriorityBadge'
import { TaskStatusBadge } from './TaskStatusBadge'
import type { Agent, WorkfloTask } from '@/types'

export enum TaskPrimaryAction {
  START = 'start',
  RESUME = 'resume',
  RESTART = 'restart',
  TRIAGE = 'triage',
  COMPLETE = 'complete'
}

const ACTION_META = {
  [TaskPrimaryAction.START]: { label: 'Start', icon: Play },
  [TaskPrimaryAction.RESUME]: { label: 'Resume', icon: Play },
  [TaskPrimaryAction.RESTART]: { label: 'Restart', icon: RotateCcw },
  [TaskPrimaryAction.TRIAGE]: { label: 'Triage', icon: Sparkles },
  [TaskPrimaryAction.COMPLETE]: { label: 'Complete', icon: Check }
}

interface TaskHeaderBarProps {
  task: WorkfloTask
  agent?: Agent | null
  action?: TaskPrimaryAction | null
  onAction?: () => void
  onBack?: () => void
  onRename: (title: string) => void | Promise<void>
  detailsOpen: boolean
  showDetailsToggle: boolean
  onToggleDetails: () => void
  onEdit: () => void
  onSnooze?: () => void
  onOpenCanvas?: () => void
  onOpenFolder?: () => void
  onOpenFullView?: () => void
  onDelete: () => void
}

export function TaskHeaderBar({
  task,
  agent,
  action,
  onAction,
  onBack,
  onRename,
  detailsOpen,
  showDetailsToggle,
  onToggleDetails,
  onEdit,
  onSnooze,
  onOpenCanvas,
  onOpenFolder,
  onOpenFullView,
  onDelete
}: TaskHeaderBarProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => setTitle(task.title), [task.title])
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menuOpen])

  const commitTitle = async () => {
    const next = title.trim()
    setEditing(false)
    if (!next || next === task.title) {
      setTitle(task.title)
      return
    }
    await onRename(next)
  }

  const actionMeta = action ? ACTION_META[action] : null
  const ActionIcon = actionMeta?.icon

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 bg-background px-3">
      {onBack && (
        <Button variant="ghost" size="icon" onClick={onBack} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commitTitle()
              if (event.key === 'Escape') { setTitle(task.title); setEditing(false) }
            }}
            className="h-8 w-full max-w-xl rounded-md border border-primary/50 bg-card px-2 text-sm font-medium outline-none"
            aria-label="Task title"
          />
        ) : (
          <button onClick={() => setEditing(true)} className="group flex max-w-full items-center gap-1.5 text-left">
            <span className="truncate text-sm font-semibold text-foreground">{task.title}</span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
      </div>
      <div className="hidden items-center gap-1.5 lg:flex">
        <TaskStatusBadge status={task.status} />
        <TaskPriorityBadge priority={task.priority} />
        <span className="inline-flex max-w-36 items-center gap-1.5 rounded-full border border-border/50 bg-card px-2 py-1 text-[11px] text-muted-foreground">
          <Bot className="h-3 w-3" />
          <span className="truncate">{agent?.name || 'Unassigned'}</span>
        </span>
      </div>
      {actionMeta && onAction && (
        <Button size="sm" onClick={onAction} className="h-8 gap-1.5 px-3" data-testid={`header-cta-${action}`}>
          {ActionIcon && <ActionIcon className="h-3.5 w-3.5" />}
          {actionMeta.label}
        </Button>
      )}
      {showDetailsToggle && (
        <Button variant={detailsOpen ? 'secondary' : 'ghost'} size="sm" onClick={onToggleDetails} className="h-8 gap-1.5">
          <Menu className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Details</span>
        </Button>
      )}
      <div ref={menuRef} className="relative">
        <Button variant="ghost" size="icon" onClick={() => setMenuOpen((open) => !open)} aria-label="Task actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
        {menuOpen && (
          <div className="absolute right-0 top-9 z-50 w-44 overflow-hidden rounded-lg border border-border/50 bg-popover p-1 shadow-xl">
            {[
              { label: 'Edit task', icon: Pencil, action: onEdit },
              { label: 'Snooze', icon: ChevronDown, action: onSnooze },
              { label: 'Open in canvas', icon: Layers, action: onOpenCanvas },
              { label: 'Open folder', icon: FolderOpen, action: onOpenFolder },
              { label: 'Open full task view', icon: ExternalLink, action: onOpenFullView }
            ].filter((item) => item.action).map((item) => (
              <button key={item.label} onClick={() => { setMenuOpen(false); item.action?.() }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground hover:bg-accent">
                <item.icon className="h-3.5 w-3.5 text-muted-foreground" />{item.label}
              </button>
            ))}
            <div className="my-1 border-t border-border/50" />
            <button onClick={() => { setMenuOpen(false); onDelete() }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-destructive hover:bg-destructive/10">
              <Trash2 className="h-3.5 w-3.5" />Delete task
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
