import { useState, useEffect } from 'react'
import { Plus, Search, ChevronDown, X, Settings, FileText, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { TaskList } from '@/components/tasks/TaskList'
import { useUIStore, type SortField } from '@/stores/ui-store'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { TaskStatus, TASK_STATUSES, TASK_PRIORITIES } from '@/types'
import type { WorkfloTask, TaskPriority } from '@/types'

interface SidebarProps {
  tasks: WorkfloTask[]
  selectedTaskId: string | null
  overdueCount: number
  onSelectTask: (id: string) => void
  onCreateTask: () => void
  onOpenSettings: () => void
}

const statusFilterOptions = [{ value: 'all', label: 'All Statuses' }, ...TASK_STATUSES]
const priorityFilterOptions = [{ value: 'all', label: 'All Priorities' }, ...TASK_PRIORITIES]
const sortOptions: { value: SortField; label: string }[] = [
  { value: 'created_at', label: 'Date Created' },
  { value: 'updated_at', label: 'Last Updated' },
  { value: 'priority', label: 'Priority' },
  { value: 'status', label: 'Status' },
  { value: 'due_date', label: 'Due Date' },
  { value: 'title', label: 'Title' }
]

export function Sidebar({ tasks, selectedTaskId, overdueCount, onSelectTask, onCreateTask, onOpenSettings }: SidebarProps) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const {
    statusFilter, priorityFilter, sourceFilter, sortField, searchQuery,
    setStatusFilter, setPriorityFilter, setSourceFilter, setSortField, setSearchQuery
  } = useUIStore()
  const { sources, syncingIds, fetchSources, syncAllEnabled } = useTaskSourceStore()
  const { fetchTasks } = useTaskStore()
  const [isSyncingAll, setIsSyncingAll] = useState(false)

  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  const handleSyncAll = async () => {
    setIsSyncingAll(true)
    await syncAllEnabled()
    await fetchTasks()
    setIsSyncingAll(false)
  }

  const hasActiveFilters = statusFilter !== 'all' || priorityFilter !== 'all' || sourceFilter !== 'all'

  return (
    <aside className="flex flex-col h-full border-r bg-sidebar overflow-hidden">
      <div className="drag-region h-13 shrink-0" />

      <div className="no-drag flex items-center justify-between px-4 pb-4 pt-1">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Tasks</h2>
          {overdueCount > 0 && (
            <span className="flex items-center justify-center min-w-5 h-5 rounded-full bg-red-500/15 text-red-400 text-[11px] font-medium px-1.5">
              {overdueCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {sources.length > 0 && (
            <Button size="sm" variant="ghost" onClick={handleSyncAll} disabled={isSyncingAll || syncingIds.size > 0} title="Sync all sources">
              {isSyncingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onOpenSettings} title="Agent Settings">
            <Settings className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" onClick={onCreateTask}>
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
        </div>
      </div>

      <div className="no-drag px-3 pb-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks..."
            className="w-full rounded-md border border-input bg-transparent pl-9 pr-8 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="no-drag px-3 pb-3 flex items-center gap-2">
        <button
          onClick={() => setFiltersOpen(!filtersOpen)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
          Filters
          {hasActiveFilters && (
            <span className="bg-primary/20 text-primary rounded-full px-1.5 text-[10px]">
              {(statusFilter !== 'all' ? 1 : 0) + (priorityFilter !== 'all' ? 1 : 0) + (sourceFilter !== 'all' ? 1 : 0)}
            </span>
          )}
        </button>
        <div className="flex-1" />
        <select
          value={sortField}
          onChange={(e) => setSortField(e.target.value as SortField)}
          className="rounded-md border border-input bg-transparent px-2 py-1.5 text-xs text-muted-foreground cursor-pointer"
        >
          {sortOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {filtersOpen && (
        <div className="no-drag px-3 pb-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as TaskStatus | 'all')}
              className="rounded-md border border-input bg-transparent px-2 py-1.5 text-xs cursor-pointer"
            >
              {statusFilterOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as TaskPriority | 'all')}
              className="rounded-md border border-input bg-transparent px-2 py-1.5 text-xs cursor-pointer"
            >
              {priorityFilterOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          {sources.length > 0 && (
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs cursor-pointer"
            >
              <option value="all">All Sources</option>
              <option value="local">Local</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => setSearchQuery('bill')}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 cursor-pointer"
            >
              <FileText className="h-3 w-3" />
              Find all bills
            </button>
          </div>
          {hasActiveFilters && (
            <button
              onClick={() => { setStatusFilter('all'); setPriorityFilter('all'); setSourceFilter('all') }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <X className="h-3 w-3" /> Clear filters
            </button>
          )}
        </div>
      )}

      <div className="mx-3 border-t" />

      <div className="flex-1 overflow-y-auto pt-1">
        <TaskList tasks={tasks} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
      </div>

      <div className="px-4 py-2.5 border-t text-xs text-muted-foreground tabular-nums">
        {tasks.filter((t) => t.status !== TaskStatus.Completed).length} active · {tasks.length} total
      </div>
    </aside>
  )
}
