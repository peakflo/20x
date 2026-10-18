import { useState, useEffect, useMemo, useCallback } from 'react'
import { Plus, Search, ChevronDown, X, FileText, RefreshCw, Loader2, Play, Pause } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { TaskList } from '@/components/tasks/TaskList'
import { SkillList } from '@/components/skills/SkillList'
import { useUIStore, type SortField } from '@/stores/ui-store'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { useUserStore } from '@/stores/user-store'
import { useSkillStore } from '@/stores/skill-store'
import { useAgentSchedulerStore } from '@/stores/agent-scheduler-store'
import { cn, isSnoozed } from '@/lib/utils'
import { countUnseenReviewTasks } from '@/hooks/use-tasks'
import { TaskStatus, TASK_STATUSES, TASK_PRIORITIES } from '@/types'
import type { WorkfloTask, TaskPriority } from '@/types'

interface SidebarProps {
  tasks: WorkfloTask[]
  selectedTaskId: string | null
  overdueCount: number
  onSelectTask: (id: string) => void
  onCreateTask: () => void
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

export function Sidebar({ tasks, selectedTaskId, overdueCount, onSelectTask, onCreateTask }: SidebarProps) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  // Use individual selectors to prevent re-renders from unrelated store changes
  const sidebarView = useUIStore((s) => s.sidebarView)
  const activeModal = useUIStore((s) => s.activeModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const statusFilter = useUIStore((s) => s.statusFilter)
  const priorityFilter = useUIStore((s) => s.priorityFilter)
  const sourceFilter = useUIStore((s) => s.sourceFilter)
  const sortField = useUIStore((s) => s.sortField)
  const searchQuery = useUIStore((s) => s.searchQuery)
  const setStatusFilter = useUIStore((s) => s.setStatusFilter)
  const setPriorityFilter = useUIStore((s) => s.setPriorityFilter)
  const setSourceFilter = useUIStore((s) => s.setSourceFilter)
  const reviewUnseenOnly = useUIStore((s) => s.reviewUnseenOnly)
  const toggleReviewUnseenOnly = useUIStore((s) => s.toggleReviewUnseenOnly)
  // Counted over the whole working set, not the filtered list, so the badge
  // does not change with other filters.
  const unseenReviewCount = useTaskStore((s) => countUnseenReviewTasks(s.tasks))
  const setSortField = useUIStore((s) => s.setSortField)
  const setSearchQuery = useUIStore((s) => s.setSearchQuery)
  const skillSearchQuery = useUIStore((s) => s.skillSearchQuery)
  const setSkillSearchQuery = useUIStore((s) => s.setSkillSearchQuery)
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth)

  const sources = useTaskSourceStore((s) => s.sources)
  const syncingIds = useTaskSourceStore((s) => s.syncingIds)
  const fetchSources = useTaskSourceStore((s) => s.fetchSources)
  const syncAllEnabled = useTaskSourceStore((s) => s.syncAllEnabled)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const skills = useSkillStore((s) => s.skills)
  const selectedSkillId = useSkillStore((s) => s.selectedSkillId)
  const fetchSkills = useSkillStore((s) => s.fetchSkills)
  const selectSkill = useSkillStore((s) => s.selectSkill)
  const createSkill = useSkillStore((s) => s.createSkill)
  const isAutoStartEnabled = useAgentSchedulerStore((s) => s.isEnabled)
  const toggleAutoStart = useAgentSchedulerStore((s) => s.toggle)
  const [isSyncingAll, setIsSyncingAll] = useState(false)

  useEffect(() => {
    fetchSources()
    useUserStore.getState().loadCurrentUser()
  }, [fetchSources])

  useEffect(() => {
    if (sidebarView === 'skills') fetchSkills()
  }, [sidebarView])

  const handleSyncAll = async () => {
    setIsSyncingAll(true)
    const userStore = useUserStore.getState()
    userStore.invalidateCache()
    await syncAllEnabled()
    await fetchTasks()
    // Re-fetch users for all enabled sources
    const enabled = sources.filter((s) => s.enabled)
    await Promise.allSettled(enabled.map((s) => userStore.fetchUsers(s.id)))
    setIsSyncingAll(false)
  }

  const handleCreateSkill = async () => {
    const skill = await createSkill({
      name: 'new-skill',
      description: 'Describe when this skill should be used',
      content: '# Instructions\n\nAdd your skill instructions here.'
    })
    if (skill) selectSkill(skill.id)
  }

  const filteredSkills = useMemo(() => {
    if (!skillSearchQuery.trim()) return skills
    const q = skillSearchQuery.toLowerCase()
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((tag) => tag.toLowerCase().includes(q))
    )
  }, [skills, skillSearchQuery])

  const hasActiveFilters = statusFilter !== 'all' || priorityFilter !== 'all' || sourceFilter !== 'all'

  // Memoize sidebar footer stats to avoid 4x redundant .filter() calls inline in JSX
  // Completed history is paged in from the database, so its count comes from
  // the store (database total) unless a filter/search narrows the list.
  const completedTotal = useTaskStore((s) => s.completedTotal)
  const completedLoaded = useTaskStore((s) => s.completedLoaded)
  const completedLoading = useTaskStore((s) => s.completedLoading)
  const loadMoreCompleted = useTaskStore((s) => s.loadMoreCompleted)
  const searchCompleted = useTaskStore((s) => s.searchCompleted)
  const isNarrowed = hasActiveFilters || reviewUnseenOnly || searchQuery.trim() !== ''

  // Search also looks in completed history that has not been paged in.
  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) return
    const timer = setTimeout(() => { void searchCompleted(q) }, 250)
    return () => clearTimeout(timer)
  }, [searchQuery, searchCompleted])

  const { activeCount, hiddenCount, totalCount } = useMemo(() => {
    let active = 0
    let hidden = 0
    let total = 0
    for (const t of tasks) {
      if (!t.parent_task_id) {
        const isCompletedHistory = t.status === TaskStatus.Completed && !(t.is_recurring && !t.recurrence_parent_id)
        if (!isNarrowed && isCompletedHistory) continue
        total++
        if (t.status !== TaskStatus.Completed) {
          if (isSnoozed(t.snoozed_until)) {
            hidden++
          } else {
            active++
          }
        }
      }
    }
    return { activeCount: active, hiddenCount: hidden, totalCount: isNarrowed ? total : total + completedTotal }
  }, [tasks, isNarrowed, completedTotal])

  const handleSelectTask = useCallback((id: string) => {
    if (activeModal === 'settings') closeModal()
    onSelectTask(id)
  }, [activeModal, closeModal, onSelectTask])

  // Drag-to-resize the sidebar (width persisted in the UI store).
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth
    const onMove = (ev: MouseEvent) => setSidebarWidth(startWidth + (ev.clientX - startX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth, setSidebarWidth])

  return (
    // Floats as a card beside the workspace, which floats the same way: same
    // radius, same hairline, same shadow. Sitting flush against the rail while
    // the work had rounded corners read as unfinished.
    <aside
      className="app-chrome glass-panel glass-scroll-panel relative flex flex-col shrink-0 overflow-hidden rounded-2xl border text-sidebar-foreground my-2 ml-2"
      style={{ width: sidebarWidth }}
    >
      {sidebarView === 'tasks' ? (
        <>
          <div className={cn('relative z-10 shrink-0', filtersOpen ? '-mb-[310px]' : '-mb-[208px]')}>
          <div className="no-drag flex items-center justify-between px-4 pt-4 pb-3">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Tasks</h2>
              {overdueCount > 0 && (
                <span className="flex items-center justify-center min-w-5 h-5 rounded-full bg-red-500/15 text-red-400 text-[11px] font-medium px-1.5">
                  {overdueCount}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {sources.length > 0 && (
                <Button size="icon" variant="ghost" onClick={handleSyncAll} disabled={isSyncingAll || syncingIds.size > 0} title="Sync all sources" className="glass-action !h-[32px] !w-[32px]">
                  {isSyncingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                </Button>
              )}
              <Button
                size="icon"
                variant={isAutoStartEnabled ? 'default' : 'ghost'}
                onClick={toggleAutoStart}
                title={isAutoStartEnabled ? 'Disable auto-run' : 'Enable auto-run'}
                className={cn('glass-action !h-[32px] !w-[32px]', isAutoStartEnabled && 'text-[#061b2c]')}
              >
                {isAutoStartEnabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              <Button size="icon" variant="ghost" onClick={onCreateTask} className="glass-action !h-[32px] !w-[32px]" title="Create task" aria-label="Create task">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="no-drag px-3 pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                data-keyboard-shortcut-search="tasks"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tasks..."
                className="glass-control h-10 w-full pl-10 pr-8 text-sm placeholder:text-[var(--glass-placeholder)] focus:ring-2 focus:ring-ring/20 transition-all"
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

          <div className="no-drag px-3 pb-3">
            <div className="glass-filter-block rounded-xl border border-[var(--glass-outline)] px-2">
            <div className="flex min-h-10 items-center gap-1">
            <button
              onClick={() => setFiltersOpen(!filtersOpen)}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-foreground hover:bg-accent/40 cursor-pointer"
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
              className="rounded-lg !border-0 !bg-transparent px-2 py-1.5 text-xs text-foreground cursor-pointer"
            >
              {sortOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            </div>
            <div className="flex items-center gap-1.5 pb-2">
              <button
                type="button"
                onClick={toggleReviewUnseenOnly}
                aria-pressed={reviewUnseenOnly}
                title="Show only tasks in review you have not opened yet"
                className={cn(
                  'flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] cursor-pointer transition-colors whitespace-nowrap',
                  reviewUnseenOnly
                    ? 'border-primary/35 bg-primary/15 text-primary'
                    : 'border-[var(--glass-outline)] text-muted-foreground hover:bg-accent/40 hover:text-foreground'
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-pink-400" />
                Review · Unseen
                {unseenReviewCount > 0 && (
                  <span data-testid="review-unseen-count" className="bg-primary/20 text-primary rounded-full px-1.5 text-[10px] tabular-nums">
                    {unseenReviewCount}
                  </span>
                )}
              </button>
            </div>
            </div>
          </div>

          {filtersOpen && (
            <div className="glass-filter-block no-drag mx-3 mb-2 space-y-2 rounded-xl border border-[var(--glass-outline)] p-2">
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
          </div>

          <div className={cn('flex-1 overflow-y-auto', filtersOpen ? 'pt-[318px]' : 'pt-[216px]')}>
            <TaskList
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              onSelectTask={handleSelectTask}
              completedTotal={isNarrowed ? undefined : completedTotal}
              hasMoreCompleted={completedLoaded < completedTotal}
              completedLoading={completedLoading}
              onLoadMoreCompleted={loadMoreCompleted}
              reviewUnseenOnly={reviewUnseenOnly}
            />
          </div>
          <div className="px-4 py-2.5 border-t text-xs text-muted-foreground tabular-nums">
            {activeCount} active
            {hiddenCount > 0 && (
              <> · {hiddenCount} hidden</>
            )}
            {' '}· {totalCount} total
          </div>
        </>
      ) : (
        <>
          <div className="no-drag flex items-center justify-between px-4 pt-4 pb-4">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Skills</h2>
            <Button size="sm" onClick={handleCreateSkill}>
              <Plus className="h-3.5 w-3.5" />
              New
            </Button>
          </div>

          <div className="no-drag px-3 pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                data-keyboard-shortcut-search="skills"
                type="search"
                value={skillSearchQuery}
                onChange={(e) => setSkillSearchQuery(e.target.value)}
                placeholder="Search skills..."
                className="glass-control w-full pl-9 pr-8 py-2 text-sm shadow-xs placeholder:text-[var(--glass-placeholder)] focus:ring-2 focus:ring-ring/20 transition-all"
              />
              {skillSearchQuery && (
                <button
                  onClick={() => setSkillSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="mx-3 border-t" />

          <div className="flex-1 overflow-y-auto pt-1">
            <SkillList skills={filteredSkills} selectedSkillId={selectedSkillId} emptyMessage={skillSearchQuery ? 'No matching skills' : undefined} onSelectSkill={(id) => {
              if (activeModal === 'settings') closeModal()
              selectSkill(id)
            }} />
          </div>

          <div className="px-4 py-2.5 border-t text-xs text-muted-foreground tabular-nums">
            {skills.length} skill{skills.length !== 1 ? 's' : ''}
          </div>
        </>
      )}

      {/* Drag-to-resize handle on the right edge */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="no-drag absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
      />
    </aside>
  )
}
