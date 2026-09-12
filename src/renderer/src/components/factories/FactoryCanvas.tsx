import { useEffect, useRef, useState } from 'react'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { useTaskGroupStore } from '@/stores/task-group-store'
import type { ResponsibilityStep } from '@shared/responsibilities'

export function syncFactoryCanvas(steps: ResponsibilityStep[], tasks: Array<{ id: string; title: string }>, allowNewPanels = true): void {
  if (!steps.length) return
  const canvas = useCanvasStore.getState()
  const origin = Math.max(0, ...canvas.panels.map(p => p.x + p.width + 40))
  for (const [i, step] of steps.entries()) {
    const task = tasks.find(t => t.id === step.taskId)
    const groups = useTaskGroupStore.getState()
    if (!task || useCanvasStore.getState().panels.some(p => p.type === 'task' && p.refId === task.id)) continue
    // Group frames own opening grouped tasks; only an explicit ungrouped flow request opens panels here.
    if (!allowNewPanels || groups.executions[step.responsibilityId] || groups.membership[task.id]) continue
    canvas.addPanel({ type: 'task', refId: task.id, title: task.title, x: origin + i * (DEFAULT_PANEL_WIDTH + 40), y: 0, width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT })
  }
  const panels = useCanvasStore.getState().panels
  for (const step of steps) {
    const to = panels.find(p => p.type === 'task' && p.refId === step.taskId)
    if (!to) continue
    for (const id of step.predecessorTaskIds ?? []) {
      const from = panels.find(p => p.type === 'task' && p.refId === id)
      if (from && from.id !== to.id) canvas.addEdge(from.id, to.id)
    }
  }
}

/** Observe only a flow the engineer explicitly chose to show; never drive execution from edges. */
export function FactoryCanvas() {
  const id = useUIStore(s => s.canvasResponsibilityId)
  const request = useUIStore(s => s.canvasResponsibilityRequest)
  const groupsLoaded = useTaskGroupStore(s => s.isLoaded)
  const tasks = useTaskStore(s => s.tasks)
  const shownGroupIds = useCanvasStore(s => s.shownGroupIds)
  const closedGroupMemberIds = useCanvasStore(s => s.closedGroupMemberIds)
  const panels = useCanvasStore(s => s.panels)
  const isLoaded = useCanvasStore(s => s.isLoaded)
  const executions = useTaskGroupStore(s => s.executions)
  const [steps, setSteps] = useState<ResponsibilityStep[]>([])
  const [error, setError] = useState('')
  const focused = useRef<string | null>(null)
  const opened = useRef<string | null>(null)
  useEffect(() => {
    const api = window.electronAPI?.responsibilities
    setSteps([]); setError('')
    if (!api) return
    let live = true; let request = 0
    const refresh = async () => {
      const current = ++request
      try {
        const snapshot = await api.snapshot()
        if (live && current === request) { setSteps(snapshot.steps); setError('') }
      } catch (e) { if (live && current === request) setError(String(e)) }
    }
    void refresh(); const off = api.onChanged(() => { void refresh() })
    return () => { live = false; off() }
  }, [])
  useEffect(() => {
    if (!isLoaded || !groupsLoaded) return
    // Draw saved Factory handoffs for any visible Group, including Groups opened from Tasks.
    syncFactoryCanvas(steps, tasks, false)
    if (!id) return
    const selectedSteps = steps.filter(s => s.responsibilityId === id)
    if (!selectedSteps.length) return
    const key = `${id}:${request}`
    const firstOpen = opened.current !== key
    if (firstOpen) {
      opened.current = key
      const groupId = executions[id]
      if (groupId) {
        const memberIds = Object.entries(useTaskGroupStore.getState().membership).filter(([, group]) => group === groupId).map(([taskId]) => taskId)
        useCanvasStore.getState().showGroup(groupId, memberIds)
      } else syncFactoryCanvas(selectedSteps, tasks, true)
    }
    const target = [...selectedSteps].reverse().find(s => s.phase === 'work' && tasks.some(t => t.id === s.taskId)) ?? selectedSteps.find(s => tasks.some(t => t.id === s.taskId))
    if (target && focused.current !== key) {
      focused.current = key
      useCanvasStore.getState().requestViewCommand({ kind: 'focus_task', taskId: target.taskId })
    }
  }, [steps, tasks, id, request, shownGroupIds, closedGroupMemberIds, panels, executions, isLoaded, groupsLoaded])
  return error ? <p role="alert" className="absolute bottom-16 left-4 z-50 rounded bg-background p-2 text-sm text-destructive">Could not refresh Factory tasks: {error}</p> : null
}
