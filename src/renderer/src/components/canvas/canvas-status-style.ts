import { TaskStatus } from '@/types'

export interface CanvasTaskStatusStyle {
  label: string
  color: string
  border: string
  bg: string
  miniFill: string
  rgb: string
}

export const CANVAS_TASK_STATUS_STYLES: Record<TaskStatus, CanvasTaskStatusStyle> = {
  [TaskStatus.NotStarted]: {
    label: 'Not Started',
    color: 'bg-zinc-500/20 text-zinc-300',
    border: 'border-zinc-500/45',
    bg: 'bg-zinc-500/10',
    miniFill: 'rgba(113,113,122,0.78)',
    rgb: '113,113,122',
  },
  [TaskStatus.Triaging]: {
    label: 'Triaging',
    color: 'bg-slate-500/20 text-slate-300',
    border: 'border-slate-500/50',
    bg: 'bg-slate-500/10',
    miniFill: 'rgba(100,116,139,0.82)',
    rgb: '100,116,139',
  },
  [TaskStatus.AgentWorking]: {
    label: 'Working',
    color: 'bg-amber-500/20 text-amber-300',
    border: 'border-amber-500/55',
    bg: 'bg-amber-500/10',
    miniFill: 'rgba(245,158,11,0.86)',
    rgb: '245,158,11',
  },
  [TaskStatus.ReadyForReview]: {
    label: 'Review',
    color: 'bg-pink-500/20 text-pink-300',
    border: 'border-pink-500/55',
    bg: 'bg-pink-500/10',
    miniFill: 'rgba(236,72,153,0.86)',
    rgb: '236,72,153',
  },
  [TaskStatus.AgentLearning]: {
    label: 'Learning',
    color: 'bg-blue-500/20 text-blue-300',
    border: 'border-blue-500/55',
    bg: 'bg-blue-500/10',
    miniFill: 'rgba(59,130,246,0.86)',
    rgb: '59,130,246',
  },
  [TaskStatus.Completed]: {
    label: 'Completed',
    color: 'bg-emerald-500/20 text-emerald-300',
    border: 'border-emerald-500/55',
    bg: 'bg-emerald-500/10',
    miniFill: 'rgba(16,185,129,0.86)',
    rgb: '16,185,129',
  },
}

export function getCanvasTaskStatusStyle(status: TaskStatus | undefined): CanvasTaskStatusStyle | null {
  return status ? CANVAS_TASK_STATUS_STYLES[status] ?? null : null
}

export function shouldPulseCanvasTaskStatusTransition(previous: TaskStatus | undefined, next: TaskStatus | undefined): boolean {
  return (
    (previous === TaskStatus.Triaging && next === TaskStatus.NotStarted) ||
    (previous === TaskStatus.AgentWorking && next === TaskStatus.ReadyForReview)
  )
}
