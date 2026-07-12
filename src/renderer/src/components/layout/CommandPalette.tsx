import { useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  Search, LayoutDashboard, Layers, CheckSquare, Zap, Settings, MessageSquare,
  Plus, Sun, Moon, CornerDownLeft, LayoutGrid, type LucideIcon
} from 'lucide-react'
import { useUIStore } from '@/stores/ui-store'
import { useThemeStore } from '@/stores/theme-store'
import { useTaskStore } from '@/stores/task-store'
import { useSkillStore } from '@/stores/skill-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { cn } from '@/lib/utils'

interface CommandItem {
  id: string
  group: string
  label: string
  icon: LucideIcon
  keywords?: string
  shortcut?: string
  run: () => void
}

const isMac = navigator.platform.toLowerCase().includes('mac')
const mod = isMac ? '⌘' : 'Ctrl'

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const openSettings = useUIStore((s) => s.openSettings)
  const closeModal = useUIStore((s) => s.closeModal)
  const openCreateModal = useUIStore((s) => s.openCreateModal)
  const toggleOrchestrator = useUIStore((s) => s.toggleOrchestrator)
  const toggleTheme = useThemeStore((s) => s.toggle)
  const themeResolved = useThemeStore((s) => s.resolved)
  const tasks = useTaskStore((s) => s.tasks)
  const selectTask = useTaskStore((s) => s.selectTask)
  const skills = useSkillStore((s) => s.skills)
  const selectSkill = useSkillStore((s) => s.selectSkill)
  const applications = useDashboardStore((s) => s.applications)
  const openApplication = useDashboardStore((s) => s.openApplication)

  // Reset query + highlight whenever the palette opens, and make sure skills +
  // applications are loaded so they're searchable even before those views are visited.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      useSkillStore.getState().fetchSkills()
      useDashboardStore.getState().fetchAllIfNeeded()
    }
  }, [open])

  const close = () => onOpenChange(false)

  const items = useMemo<CommandItem[]>(() => {
    const goto = (view: 'dashboard' | 'canvas' | 'tasks' | 'skills') => () => { closeModal(); setSidebarView(view); close() }
    const base: CommandItem[] = [
      { id: 'nav-dashboard', group: 'Navigation', label: 'Go to Dashboard', icon: LayoutDashboard, keywords: 'home overview', shortcut: `${mod}1`, run: goto('dashboard') },
      { id: 'nav-canvas', group: 'Navigation', label: 'Go to Canvas', icon: Layers, keywords: 'board panels', shortcut: `${mod}2`, run: goto('canvas') },
      { id: 'nav-tasks', group: 'Navigation', label: 'Go to Tasks', icon: CheckSquare, keywords: 'todo list', shortcut: `${mod}3`, run: goto('tasks') },
      { id: 'nav-skills', group: 'Navigation', label: 'Go to Skills', icon: Zap, keywords: 'abilities', shortcut: `${mod}4`, run: goto('skills') },
      { id: 'act-new-task', group: 'Actions', label: 'New Task', icon: Plus, keywords: 'create add', run: () => { openCreateModal(); close() } },
      { id: 'act-mastermind', group: 'Actions', label: 'Toggle Mastermind', icon: MessageSquare, keywords: 'orchestrator chat', run: () => { toggleOrchestrator(); close() } },
      { id: 'act-settings', group: 'Actions', label: 'Open Settings', icon: Settings, keywords: 'preferences config', run: () => { openSettings(); close() } },
      { id: 'act-theme', group: 'Actions', label: themeResolved === 'dark' ? 'Switch to Light mode' : 'Switch to Dark mode', icon: themeResolved === 'dark' ? Sun : Moon, keywords: 'theme dark light appearance', run: () => { toggleTheme(); close() } },
    ]

    const q = query.trim().toLowerCase()
    const filteredBase = q
      ? base.filter((c) => (c.label + ' ' + (c.keywords ?? '')).toLowerCase().includes(q))
      : base

    // Content search — only when the user has typed something.
    const appItems: CommandItem[] = q
      ? applications
          .filter((a) => a.name.toLowerCase().includes(q))
          .slice(0, 6)
          .map((a) => ({
            id: `app-${a.workflowId}`,
            group: 'Applications',
            label: a.name,
            icon: LayoutGrid,
            run: () => { closeModal(); setSidebarView('dashboard'); void openApplication(a.workflowId); close() },
          }))
      : []

    const skillItems: CommandItem[] = q
      ? skills
          .filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
          .slice(0, 6)
          .map((s) => ({
            id: `skill-${s.id}`,
            group: 'Skills',
            label: s.name,
            icon: Zap,
            run: () => { closeModal(); selectSkill(s.id); setSidebarView('skills'); close() },
          }))
      : []

    const taskItems: CommandItem[] = q
      ? tasks
          .filter((t) => !t.parent_task_id && t.title.toLowerCase().includes(q))
          .slice(0, 8)
          .map((t) => ({
            id: `task-${t.id}`,
            group: 'Tasks',
            label: t.title,
            icon: CheckSquare,
            run: () => { closeModal(); selectTask(t.id); setSidebarView('tasks'); close() },
          }))
      : []

    return [...filteredBase, ...appItems, ...skillItems, ...taskItems]
  }, [query, tasks, skills, applications, themeResolved, closeModal, setSidebarView, openCreateModal, toggleOrchestrator, openSettings, toggleTheme, selectTask, selectSkill, openApplication])

  // Keep highlight within bounds when the list shrinks.
  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, items.length - 1))) }, [items.length])

  // Scroll highlighted item into view.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run() }
  }

  let lastGroup = ''

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-[var(--overlay)] backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          aria-label="Command palette"
          className="fixed left-1/2 top-[14%] z-[101] w-full max-w-[560px] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tasks, skills, apps — or run a command…"
              className="h-12 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <kbd className="hidden shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:block">esc</kbd>
          </div>

          <div ref={listRef} className="max-h-[54vh] overflow-y-auto p-1.5">
            {items.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">No results</div>
            )}
            {items.map((item, i) => {
              const showGroup = item.group !== lastGroup
              lastGroup = item.group
              const isActive = i === active
              const Icon = item.icon
              return (
                <div key={item.id}>
                  {showGroup && (
                    <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {item.group}
                    </div>
                  )}
                  <button
                    data-active={isActive}
                    onMouseMove={() => setActive(i)}
                    onClick={() => item.run()}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                      isActive ? 'bg-accent text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate text-foreground">{item.label}</span>
                    {item.shortcut && (
                      <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.shortcut}</kbd>
                    )}
                    {isActive && !item.shortcut && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
                  </button>
                </div>
              )
            })}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
