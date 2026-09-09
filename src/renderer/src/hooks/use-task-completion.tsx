import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { CompleteAtSourceDialog } from '@/components/tasks/CompleteAtSourceDialog'
import { taskApi } from '@/lib/ipc-client'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { PluginActionId, TaskStatus } from '@/types'
import type { TaskSource, WorkfloTask } from '@/types'

export interface UseTaskCompletionOptions {
  onToast?: (message: string, isError?: boolean) => void
}
export interface CompleteTaskRequestOptions {
  onCompleted?: (task: WorkfloTask) => void
}

interface PendingCompletion {
  taskId: string
  options?: CompleteTaskRequestOptions
}

/** Workflo owns the status of its tasks; only the server can confirm completion. */
export function isServerManagedTask(task: WorkfloTask, sources: TaskSource[]): boolean {
  if (task.server_managed) return true
  return !!task.source_id && sources.find((s) => s.id === task.source_id)?.plugin_id === 'peakflo'
}

/**
 * Single completion path for tasks.
 *
 * - No source: completes in 20x immediately.
 * - Workflo (server-managed): the server confirms completion through a task
 *   action. There is nothing to ask.
 * - Any other source (Notion, Linear, YouTrack, GitHub, HubSpot): the user
 *   picks "Update <source> too" or "Only in 20x". A recorded choice on the
 *   task (`complete_at_source`, e.g. from the feedback dialog) is honoured
 *   without asking again.
 */
export function useTaskCompletion({ onToast }: UseTaskCompletionOptions = {}) {
  const executeAction = useTaskSourceStore((s) => s.executeAction)
  const sources = useTaskSourceStore((s) => s.sources)

  const [pending, setPending] = useState<PendingCompletion | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  // The dialog reads the task through the store, so an import that arrives
  // while the dialog is open cannot make the prompt act on stale data.
  const tasks = useTaskStore((s) => s.tasks)
  const pendingTask = useMemo(
    () => (pending ? tasks.find((t) => t.id === pending.taskId) : undefined),
    [pending, tasks]
  )

  const sourceName = useMemo(() => {
    if (!pendingTask?.source_id) return 'the task source'
    const source = sources.find((s) => s.id === pendingTask.source_id)
    return source?.name || pendingTask.source || 'the task source'
  }, [pendingTask, sources])

  /** Source-less 20x task: a plain local status write. */
  const completeLocalTask = useCallback(
    async (task: WorkfloTask, options?: CompleteTaskRequestOptions) => {
      await useTaskStore.getState().updateTask(task.id, { status: TaskStatus.Completed })
      options?.onCompleted?.({ ...task, status: TaskStatus.Completed })
      onToast?.(`"${task.title}" completed`)
    },
    [onToast]
  )

  /**
   * Closes the task at its source. The source plugin confirms the change and
   * SyncManager applies the completion in 20x; a refusal leaves the task open.
   */
  const completeAtSource = useCallback(
    async (task: WorkfloTask, options: CompleteTaskRequestOptions | undefined, recordChoice: boolean) => {
      const action = task.output_fields.find((f) => f.id === 'action')?.value
      const result = await executeAction(action ? String(action) : PluginActionId.Complete, task.id, task.source_id!)
      if (!result.success) throw new Error(result.error || 'The task source did not confirm completion.')
      if (recordChoice) {
        // No status in this write, so it passes the completion guard. It records
        // the answer so a reopened task does not ask again.
        try {
          await useTaskStore.getState().updateTask(task.id, { complete_at_source: true })
        } catch (error) {
          console.error('[useTaskCompletion] Could not record the completion choice:', error)
        }
      }
      await useTaskStore.getState().fetchTasks()
      options?.onCompleted?.(task)
      onToast?.(`"${task.title}" completed`)
    },
    [executeAction, onToast]
  )

  /** "Only in 20x": the main process owns the guard that lets this close a sourced task. */
  const completeInTwentyXOnly = useCallback(
    async (task: WorkfloTask, options?: CompleteTaskRequestOptions) => {
      await taskApi.completeLocally(task.id)
      await useTaskStore.getState().fetchTasks()
      options?.onCompleted?.({ ...task, status: TaskStatus.Completed, complete_at_source: false })
      onToast?.(`"${task.title}" completed in 20x only`)
    },
    [onToast]
  )

  /** Applies a sourced completion for a non-Workflo task; returns false when it failed. */
  const runSourcedCompletion = useCallback(
    async (task: WorkfloTask, options: CompleteTaskRequestOptions | undefined, atSource: boolean): Promise<boolean> => {
      try {
        if (atSource) await completeAtSource(task, options, true)
        else await completeInTwentyXOnly(task, options)
        return true
      } catch (error) {
        onToast?.(error instanceof Error ? error.message : 'Task completion failed.', true)
        return false
      }
    },
    [completeAtSource, completeInTwentyXOnly, onToast]
  )

  /**
   * Entry point for every user-triggered completion. Reads the task from the
   * store so callers cannot pass a stale copy.
   */
  const requestComplete = useCallback(
    async (taskId: string, options?: CompleteTaskRequestOptions) => {
      const task = useTaskStore.getState().tasks.find((t) => t.id === taskId)
      if (!task) return
      try {
        if (!task.source_id) {
          await completeLocalTask(task, options)
          return
        }
        if (isServerManagedTask(task, useTaskSourceStore.getState().sources)) {
          await completeAtSource(task, options, false)
          return
        }
      } catch (error) {
        onToast?.(error instanceof Error ? error.message : 'Task completion failed.', true)
        return
      }
      // The feedback dialog asks the same question for tasks that ran an agent
      // and records the answer on the task. Honour it instead of asking twice.
      if (task.complete_at_source != null) {
        await runSourcedCompletion(task, options, task.complete_at_source)
        return
      }
      setPending({ taskId, options })
    },
    [completeAtSource, completeLocalTask, onToast, runSourcedCompletion]
  )

  const resolvePending = useCallback(
    async (atSource: boolean) => {
      if (!pending || isBusy) return
      const task = useTaskStore.getState().tasks.find((t) => t.id === pending.taskId)
      if (!task) {
        setPending(null)
        return
      }
      setIsBusy(true)
      try {
        const done = await runSourcedCompletion(task, pending.options, atSource)
        // A failure keeps the dialog open so the user can retry or pick the other option.
        if (done) setPending(null)
      } finally {
        setIsBusy(false)
      }
    },
    [isBusy, pending, runSourcedCompletion]
  )

  const handleCompleteAtSource = useCallback(() => void resolvePending(true), [resolvePending])
  const handleCompleteManually = useCallback(() => void resolvePending(false), [resolvePending])
  const handleCancel = useCallback(() => {
    if (!isBusy) setPending(null)
  }, [isBusy])

  const completionDialog: ReactNode = (
    <CompleteAtSourceDialog
      isOpen={pending !== null}
      taskTitle={pendingTask?.title || ''}
      sourceName={sourceName}
      isBusy={isBusy}
      onCompleteAtSource={handleCompleteAtSource}
      onCompleteManually={handleCompleteManually}
      onCancel={handleCancel}
    />
  )

  return { requestComplete, completionDialog }
}
