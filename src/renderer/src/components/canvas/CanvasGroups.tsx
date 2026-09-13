import { useEffect, useMemo, useState } from 'react'
import { Layers, X } from 'lucide-react'
import { useCanvasStore, DEFAULT_PANEL_HEIGHT, DEFAULT_PANEL_WIDTH } from '@/stores/canvas-store'
import { useTaskStore } from '@/stores/task-store'
import { useTaskGroupStore } from '@/stores/task-group-store'
import { useUIStore } from '@/stores/ui-store'
import { GroupControls } from '../tasks/TaskGroups'
import { WorkspaceBadge } from '@/components/ui/WorkspaceBadge'

const GAP = 36
const HEADER = 42
const PAD = 24

function layoutFor(index: number, count: number, x: number, y: number) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count || 1)))
  return {
    x: x + (index % columns) * (DEFAULT_PANEL_WIDTH + GAP),
    y: y + Math.floor(index / columns) * (DEFAULT_PANEL_HEIGHT + GAP) + HEADER,
  }
}

export function CanvasGroups() {
  const groups = useTaskGroupStore((s) => s.groups)
  const membership = useTaskGroupStore((s) => s.membership)
  const projectId = useUIStore((s) => s.mastermindProjectId)
  const workspaceDataLoaded = useUIStore((s) => s.mastermindSnapshotLoaded)
  const visibleGroups = useMemo(() => projectId && workspaceDataLoaded ? groups.filter(group => group.projectId === projectId) : groups, [groups, projectId, workspaceDataLoaded])
  const canvasGroupId = useTaskGroupStore((s) => s.canvasGroupId)
  const tasks = useTaskStore((s) => s.tasks)
  const isLoaded = useCanvasStore((s) => s.isLoaded)
  const panels = useCanvasStore((s) => s.panels)
  const shownGroupIds = useCanvasStore((s) => s.shownGroupIds)
  const closedGroupMemberIds = useCanvasStore((s) => s.closedGroupMemberIds)
  const hideGroup = useCanvasStore((s) => s.hideGroup)
  const updatePanel = useCanvasStore((s) => s.updatePanel)

  useEffect(() => {
    if (!isLoaded || !canvasGroupId) return
    const group = visibleGroups.find((candidate) => candidate.id === canvasGroupId)
    if (!group) return
    useTaskGroupStore.setState({ canvasGroupId: null })
    useCanvasStore.getState().showGroup(group.id, Object.entries(membership).filter(([, id]) => id === group.id).map(([taskId]) => taskId))
    useUIStore.getState().setSidebarView('canvas')
  }, [canvasGroupId, visibleGroups, membership, isLoaded])

  const groupMembers = useMemo(() => visibleGroups.map((group) => ({
    group,
    taskIds: Object.entries(membership).filter(([, groupId]) => groupId === group.id).map(([taskId]) => taskId),
  })), [visibleGroups, membership])

  useEffect(() => {
    if (!isLoaded) return
    for (const { group, taskIds } of groupMembers) {
      if (!shownGroupIds.includes(group.id)) continue
      const canvas = useCanvasStore.getState()
      const closed = closedGroupMemberIds[group.id] ?? []
      const visibleIds = taskIds.filter((id) => !closed.includes(id))
      const existing = new Set<string>()
      const memberPanels = canvas.panels.filter((candidate) => candidate.type === 'task' && candidate.refId && taskIds.includes(candidate.refId))
      for (const taskId of visibleIds) {
        const panel = memberPanels.find((candidate) => candidate.refId === taskId)
        if (panel) {
          existing.add(taskId)
          if (panel.canvasGroupId !== group.id) updatePanel(panel.id, { canvasGroupId: group.id })
        }
      }
      const rightOfExisting = memberPanels.length ? Math.max(...memberPanels.map((panel) => panel.x + panel.width)) + GAP : Math.max(0, ...canvas.panels.map((panel) => panel.x + panel.width + GAP))
      const originX = rightOfExisting
      const originY = memberPanels.length ? Math.min(...memberPanels.map((panel) => panel.y)) - HEADER : 0
      for (const [index, taskId] of visibleIds.filter((id) => !existing.has(id)).entries()) {
        const task = tasks.find((candidate) => candidate.id === taskId)
        if (!task) continue
        const position = layoutFor(index, visibleIds.length - existing.size, originX, originY)
        canvas.addPanel({ type: 'task', refId: task.id, canvasGroupId: group.id, title: task.title, ...position, width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT })
      }
    }
  }, [groupMembers, tasks, shownGroupIds, closedGroupMemberIds, updatePanel, isLoaded])

  useEffect(() => {
    if (!isLoaded) return
    for (const panel of panels) {
      if (panel.type !== 'task' || !panel.refId) continue
      const groupId = membership[panel.refId]
      if (panel.canvasGroupId !== groupId) updatePanel(panel.id, { canvasGroupId: groupId })
    }
  }, [isLoaded, membership, panels, updatePanel])

  const frames = groupMembers.filter(({ group }) => shownGroupIds.includes(group.id)).map(({ group, taskIds }, index) => {
    const members = taskIds.map((taskId) => panels.find((panel) => panel.type === 'task' && panel.refId === taskId)).filter(Boolean) as typeof panels
    const minX = members.length ? Math.min(...members.map((panel) => panel.x)) - PAD : Math.max(0, ...panels.map((panel) => panel.x + panel.width + GAP)) + index * (DEFAULT_PANEL_WIDTH + GAP)
    const minY = members.length ? Math.min(...members.map((panel) => panel.y)) - HEADER : 0
    const maxX = members.length ? Math.max(...members.map((panel) => panel.x + panel.width)) + PAD : minX + DEFAULT_PANEL_WIDTH
    const maxY = members.length ? Math.max(...members.map((panel) => panel.y + panel.height)) + PAD : minY + 180
    return { group, taskIds, x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  })

  return <>
    {frames.map(({ group, taskIds, x, y, width, height }) => (
      <div key={group.id} data-canvas-group-frame={group.id} data-canvas-group-member-count={taskIds.length} className="absolute rounded-2xl border-2 border-primary/40 bg-primary/5" style={{ left: x, top: y, width, height, zIndex: 0, pointerEvents: 'none' }}>
        <div className="flex h-10 items-center gap-2 border-b border-primary/20 px-3 text-xs font-semibold text-primary" style={{ pointerEvents: 'auto' }}>
          <Layers className="h-3.5 w-3.5" />
          <span>{group.name}</span>
          <WorkspaceBadge projectId={group.projectId} />
          <span className="text-muted-foreground">{taskIds.length}</span>
          <GroupControls groupId={group.id} />
          <button type="button" aria-label={`Hide ${group.name}`} className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => hideGroup(group.id)}><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>
    ))}
  </>
}

export function CanvasGroupsMenu() {
  const groups = useTaskGroupStore((s) => s.groups)
  const membership = useTaskGroupStore((s) => s.membership)
  const projectId = useUIStore((s) => s.mastermindProjectId)
  const workspaceDataLoaded = useUIStore((s) => s.mastermindSnapshotLoaded)
  const visibleGroups = projectId && workspaceDataLoaded ? groups.filter(group => group.projectId === projectId) : groups
  const setView = useTaskGroupStore((s) => s.setView)
  const showGroup = useCanvasStore((s) => s.showGroup)
  const shownGroupIds = useCanvasStore((s) => s.shownGroupIds)
  const setSidebarView = useUIStore((s) => s.setSidebarView)
  const [menuOpen, setMenuOpen] = useState(false)

  return <div data-canvas-groups-menu="true" className="absolute left-3 top-12 z-20" style={{ pointerEvents: 'auto' }}>
    <button type="button" className="rounded-lg border border-border/50 bg-popover px-2 py-1 text-xs shadow" onClick={() => setMenuOpen((open) => !open)}><Layers className="mr-1 inline h-3.5 w-3.5" />Groups</button>
    {menuOpen && <div className="mt-1 w-64 rounded-lg border border-border/50 bg-popover p-1 shadow-xl">
      <button type="button" className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => { setSidebarView('tasks'); setView('groups'); setMenuOpen(false) }}>Manage groups in Tasks</button>
      {visibleGroups.length === 0 && <p className="p-2 text-xs text-muted-foreground">No groups yet.</p>}
      {visibleGroups.map((group) => <div key={group.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { showGroup(group.id, Object.entries(membership).filter(([, id]) => id === group.id).map(([taskId]) => taskId)); setMenuOpen(false) }}>{group.name} <span className="text-muted-foreground">{shownGroupIds.includes(group.id) ? 'Shown' : 'Show'}</span></button><WorkspaceBadge projectId={group.projectId} />
        <GroupControls groupId={group.id} />
      </div>)}
    </div>}
  </div>
}
