import { useEffect, useMemo, useState } from 'react'
import { Folder, Layers, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { TaskList } from './TaskList'
import type { WorkfloTask } from '@/types'
import { TaskStatus } from '@/types'
import { useTaskGroupStore } from '@/stores/task-group-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { WorkspaceBadge } from '@/components/ui/WorkspaceBadge'

interface TaskGroupsProps {
  tasks: WorkfloTask[]
  allTasks: WorkfloTask[]
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
  onCreateTask: () => void
}
const attentionStatuses = new Set([TaskStatus.ReadyForReview])

function SelectionList({
  tasks,
  selected,
  toggle,
  membership
}: {
  tasks: WorkfloTask[]
  selected: Set<string>
  toggle: (id: string) => void
  membership: Record<string, string>
}) {
  const [query, setQuery] = useState('')
  const groups = useTaskGroupStore((s) => s.groups)
  return (
    <div>
      <input
        aria-label="Find tasks for group"
        placeholder="Find tasks…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-2 w-full rounded border bg-background px-2 py-1.5 text-sm"
      />
      <div className="max-h-64 space-y-1 overflow-y-auto rounded border p-2">
        {tasks
          .filter((task) => task.title.toLowerCase().includes(query.toLowerCase()))
          .map((task) => (
            <label key={task.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
              <input
                aria-label={`Select ${task.title}`}
                type="checkbox"
                checked={selected.has(task.id)}
                onChange={() => toggle(task.id)}
              />
              <span className="min-w-0 flex-1 truncate" title={task.title}>
                {task.title}
              </span>
              {membership[task.id] && (
                <span className="text-[10px] text-muted-foreground">
                  {groups.find((g) => g.id === membership[task.id])?.name ?? 'Grouped'}
                </span>
              )}
            </label>
          ))}
      </div>
    </div>
  )
}

export function GroupControls({ groupId }: { groupId: string }) {
  const group = useTaskGroupStore((s) => s.groups.find((item) => item.id === groupId))
  const error = useTaskGroupStore((s) => s.error)
  const manage = useTaskGroupStore((s) => s.manage)
  const setView = useTaskGroupStore((s) => s.setView)
  const showOnCanvas = useTaskGroupStore((s) => s.showOnCanvas)
  const setCreationGroup = useTaskGroupStore((s) => s.setCreationGroup)
  const membership = useTaskGroupStore((s) => s.membership)
  const tasks = useTaskStore((s) => s.tasks)
  const selectTask = useTaskStore((s) => s.selectTask)
  const openCreateModal = useUIStore((s) => s.openCreateModal)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  if (!group) return null
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const update = async () => {
    const result = await manage({ action: 'update', group_id: groupId, name: name.trim(), description })
    if (result.success) setOpen(false)
  }
  const assign = async (targetGroupId: string | null) => {
    if (!selected.size) return
    const result = await manage({ action: 'assign', group_id: targetGroupId, task_ids: [...selected] })
    if (result.success) setSelected(new Set())
  }
  const removeGroup = async (withTasks: boolean) => {
    const result = await manage({ action: withTasks ? 'delete_with_tasks' : 'delete', group_id: groupId })
    if (result.success) {
      setOpen(false)
      setView('groups')
      selectTask(null)
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        title="Manage group"
        aria-label={`Manage ${group.name}`}
        onClick={() => {
          setName(group.name)
          setDescription(group.description)
          setSelected(new Set())
          setOpen(true)
        }}
      >
        <Layers className="h-3 w-3" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage {group.name}</DialogTitle>
            <DialogDescription>Update this group or manage its tasks.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {error && (
              <p
                role="alert"
                className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
              >
                {error}
              </p>
            )}
            <div className="space-y-2">
              <label className="block text-xs text-muted-foreground">
                Name
                <input
                  aria-label="Group name"
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Description
                <textarea
                  aria-label="Group description"
                  maxLength={2000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1 min-h-16 w-full rounded border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <Button size="sm" onClick={() => void update()} disabled={!name.trim()}>
                Save changes
              </Button>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium">Add, move, or remove tasks</div>
              <SelectionList tasks={tasks} selected={selected} toggle={toggle} membership={membership} />
              {selected.size > 0 && (
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" onClick={() => void assign(groupId)}>
                    Add / move here
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void assign(null)}>
                    Remove from group
                  </Button>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2 border-t pt-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  showOnCanvas(groupId)
                  setSidebarView('canvas')
                  setOpen(false)
                }}
              >
                <Layers className="h-3 w-3" /> Show on Canvas
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCreationGroup(groupId)
                  setOpen(false)
                  openCreateModal()
                }}
              >
                <Plus className="h-3 w-3" /> New task in group
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 border-t pt-3">
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void removeGroup(false)}>
                <Trash2 className="h-3 w-3" /> Delete group only
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void removeGroup(true)}>
                <Trash2 className="h-3 w-3" /> Delete group + tasks
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}

function NewGroupDialog({
  tasks,
  selected,
  toggle,
  onCreate,
  error,
  open,
  setOpen
}: {
  tasks: WorkfloTask[]
  selected: Set<string>
  toggle: (id: string) => void
  onCreate: (name: string, description: string, projectId?: string) => Promise<void>
  error: string | null
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const selectedWorkspace = useUIStore((state) => state.mastermindProjectId)
  useEffect(() => {
    if (open) {
      setProjectId(selectedWorkspace)
      void window.electronAPI?.responsibilities
        ?.snapshot()
        .then((snapshot) => setProjects(snapshot.projects))
        .catch(() => setProjects([]))
    }
  }, [open, selectedWorkspace])
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>Create an empty group or include selected tasks.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {error && (
            <p
              role="alert"
              className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}
          <input
            aria-label="New group name"
            maxLength={120}
            autoFocus
            placeholder="Group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
          />
          <textarea
            aria-label="New group description"
            maxLength={2000}
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-16 w-full rounded border bg-background px-2 py-1.5 text-sm"
          />
          <select
            aria-label="Group project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Local group</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <SelectionList tasks={tasks} selected={selected} toggle={toggle} membership={{}} />
          <Button onClick={() => void onCreate(name, description, projectId || undefined)} disabled={!name.trim()}>
            Create group
          </Button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function TaskGroups({ tasks, allTasks, selectedTaskId, onSelectTask, onCreateTask }: TaskGroupsProps) {
  const groups = useTaskGroupStore((s) => s.groups)
  const membership = useTaskGroupStore((s) => s.membership)
  const view = useTaskGroupStore((s) => s.view)
  const error = useTaskGroupStore((s) => s.error)
  const fetch = useTaskGroupStore((s) => s.fetch)
  const manage = useTaskGroupStore((s) => s.manage)
  const setView = useTaskGroupStore((s) => s.setView)
  const setCreationGroup = useTaskGroupStore((s) => s.setCreationGroup)
  const projectId = useUIStore((s) => s.mastermindProjectId)
  const workspaceDataLoaded = useUIStore((s) => s.mastermindSnapshotLoaded)
  const selectTask = useTaskStore((s) => s.selectTask)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  useEffect(() => {
    void fetch()
  }, [fetch])
  const visibleGroups = useMemo(() => projectId && workspaceDataLoaded ? groups.filter(group => group.projectId === projectId) : groups, [groups, projectId, workspaceDataLoaded])
  useEffect(() => {
    if (projectId && workspaceDataLoaded && !['groups', 'all', 'ungrouped'].includes(view) && !visibleGroups.some(group => group.id === view)) setView('groups')
  }, [projectId, workspaceDataLoaded, view, visibleGroups, setView])
  const openGroup = (id: string) => {
    selectTask(null)
    setSelected(new Set())
    setView(id)
  }
  const visibleTasks = useMemo(
    () =>
      view === 'all'
        ? tasks
        : view === 'ungrouped'
          ? tasks.filter((task) => !membership[task.id])
          : tasks.filter((task) => membership[task.id] === view),
    [membership, tasks, view]
  )
  const createGroup = async (name: string, description: string, projectId?: string) => {
    const result = await manage({
      action: 'create',
      name: name.trim(),
      description,
      project_id: projectId,
      task_ids: [...selected]
    })
    if (result.success) {
      setNewGroupOpen(false)
      setSelected(new Set())
      openGroup(result.groupId ?? 'groups')
    }
  }
  if (view === 'groups')
    return (
      <div className="flex flex-col gap-2 p-3">
        {error && (
          <p
            role="alert"
            className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Folder className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Groups</span>
          <Button size="sm" className="ml-auto" onClick={onCreateTask}>
            <Plus className="h-3.5 w-3.5" /> Task
          </Button>
        </div>
        <Button variant="ghost" className="justify-start" onClick={() => setNewGroupOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> New group
        </Button>
        {visibleGroups.map((group) => {
          const groupTasks = allTasks.filter((task) => membership[task.id] === group.id)
          const attention = groupTasks.filter((task) => attentionStatuses.has(task.status)).length
          return (
            <button
              key={group.id}
              onClick={() => openGroup(group.id)}
              className="rounded-lg border p-3 text-left hover:bg-accent"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Folder className="h-4 w-4" />
                {group.name}
                <WorkspaceBadge projectId={group.projectId} className="ml-auto" />
                <span className="text-xs text-muted-foreground">{groupTasks.length}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {group.description || 'No description'}
                {attention > 0 && <span className="ml-2 text-amber-400">{attention} attention</span>}
              </div>
            </button>
          )
        })}
        <button
          onClick={() => openGroup('ungrouped')}
          className="rounded-lg border p-3 text-left text-sm hover:bg-accent"
        >
          Ungrouped{' '}
          <span className="float-right text-xs text-muted-foreground">
            {allTasks.filter((task) => !membership[task.id]).length}
          </span>
        </button>
        <button onClick={() => openGroup('all')} className="rounded-lg border p-3 text-left text-sm hover:bg-accent">
          All tasks <span className="float-right text-xs text-muted-foreground">{allTasks.length}</span>
        </button>
        <NewGroupDialog
          tasks={allTasks}
          selected={selected}
          toggle={(id) =>
            setSelected((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
          onCreate={createGroup}
          error={error}
          open={newGroupOpen}
          setOpen={setNewGroupOpen}
        />
      </div>
    )
  const group = groups.find((item) => item.id === view)
  return (
    <div className="flex h-full flex-col">
      {error && (
        <p
          role="alert"
          className="m-2 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setView('groups')}>
          Groups
        </button>
        <span>/</span>
        <span className="truncate text-sm font-medium">
          {group?.name ?? (view === 'all' ? 'All tasks' : 'Ungrouped')}
        </span>
        {group && <WorkspaceBadge projectId={group.projectId} />}
        {group && (
          <span className="text-xs text-muted-foreground">
            {allTasks.filter((task) => membership[task.id] === group.id).length}
          </span>
        )}
        {group && <GroupControls groupId={group.id} />}
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => {
            setCreationGroup(group?.id)
            useUIStore.getState().openCreateModal()
          }}
        >
          <Plus className="h-3.5 w-3.5" /> Task
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskList tasks={visibleTasks} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
      </div>
    </div>
  )
}
