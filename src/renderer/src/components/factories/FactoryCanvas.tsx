import { useEffect, useRef, useState } from 'react'
import { useCanvasStore, DEFAULT_PANEL_WIDTH, DEFAULT_PANEL_HEIGHT } from '@/stores/canvas-store'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import type { ResponsibilityStep } from '@shared/responsibilities'

export function syncFactoryCanvas(steps: ResponsibilityStep[], tasks: Array<{ id: string; title: string }>): void {
  if (!steps.length) return
  const canvas = useCanvasStore.getState()
  const origin = Math.max(0, ...canvas.panels.map(p => p.x + p.width + 40))
  for (const [i, step] of steps.entries()) {
    const task = tasks.find(t => t.id === step.taskId)
    if (!task || useCanvasStore.getState().panels.some(p => p.type === 'task' && p.refId === task.id)) continue
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
  const tasks = useTaskStore(s => s.tasks)
  const [steps, setSteps] = useState<ResponsibilityStep[]>([])
  const [error, setError] = useState('')
  const focused = useRef<string | null>(null)
  useEffect(() => {
    const api = window.electronAPI?.responsibilities
    setSteps([]); setError('')
    if (!id || !api) return
    let live = true; let request = 0
    const refresh = async () => {
      const current = ++request
      try {
        const snapshot = await api.snapshot()
        if (live && current === request) { setSteps(snapshot.steps.filter(s => s.responsibilityId === id)); setError('') }
      } catch (e) { if (live && current === request) setError(String(e)) }
    }
    void refresh(); const off = api.onChanged(() => { void refresh() })
    return () => { live = false; off() }
  }, [id])
  useEffect(() => {
    if (!id || steps.some(s => s.responsibilityId !== id)) return
    syncFactoryCanvas(steps, tasks)
    const target = [...steps].reverse().find(s => s.phase === 'work' && tasks.some(t => t.id === s.taskId)) ?? steps.find(s => tasks.some(t => t.id === s.taskId))
    if (target && focused.current !== id) {
      focused.current = id
      useCanvasStore.getState().requestViewCommand({ kind: 'focus_task', taskId: target.taskId })
    }
  }, [steps, tasks, id])
  return error ? <p role="alert" className="absolute bottom-16 left-4 z-50 rounded bg-background p-2 text-sm text-destructive">Could not refresh Factory tasks: {error}</p> : null
}
