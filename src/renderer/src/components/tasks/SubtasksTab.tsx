import { useState } from 'react'
import { ArrowUpRight, Search } from 'lucide-react'
import type { WorkfloTask } from '@/types'
import { TaskStatusBadge } from './TaskStatusBadge'
import { cn } from '@/lib/utils'
import { filterSubtasks, SUBTASK_FILTERS, type SubtaskFilter } from '@shared/subtask-filter'

interface SubtasksTabProps {
  subtasks: WorkfloTask[]
  onNavigateToTask?: (taskId: string) => void
}

export function SubtasksTab({ subtasks, onNavigateToTask }: SubtasksTabProps) {
  const [filter, setFilter] = useState<SubtaskFilter>('all')
  const [query, setQuery] = useState('')
  const visible = filterSubtasks(subtasks, filter, query)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="subtasks-tab-content">
      <div className="shrink-0 space-y-3 border-b border-border/50 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Subtasks</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{visible.length} of {subtasks.length}</span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="search"
            aria-label="Search subtasks"
            placeholder="Search subtasks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full rounded-md border border-border/50 bg-card/60 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Filter subtasks">
          {SUBTASK_FILTERS.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={cn('rounded-md px-2.5 py-1 text-xs transition-colors', filter === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">No subtasks match this search.</p>
        ) : visible.map((subtask) => (
          <button key={subtask.id} type="button" onClick={() => onNavigateToTask?.(subtask.id)} disabled={!onNavigateToTask} className="group flex w-full items-start justify-between gap-3 rounded-md px-3 py-3 text-left hover:bg-accent/50 disabled:cursor-default" aria-label={`Open subtask ${subtask.title}`}>
            <span className="min-w-0 space-y-1.5">
              <span className="block break-words text-sm font-medium text-foreground">{subtask.title}</span>
              <TaskStatusBadge status={subtask.status} />
            </span>
            {onNavigateToTask && <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />}
          </button>
        ))}
      </div>
    </div>
  )
}
