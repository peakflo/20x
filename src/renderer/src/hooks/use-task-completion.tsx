import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { CompleteAtSourceDialog } from '@/components/tasks/CompleteAtSourceDialog'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { TaskStatus, PluginActionId } from '@/types'
import type { WorkfloTask } from '@/types'

export interface UseTaskCompletionOptions {
  /** Shows a short message to the user. Optional. */
  onToast?: (message: string, isError?: boolean) => void
}

export interface CompleteTaskRequestOptions {
  /** Runs after the task is completed. */
  onCompleted?: (task: WorkfloTask) => void
}

interface PendingCompletion {
  taskId: string
  options?: CompleteTaskRequestOptions
}

/**
 * Single completion path for tasks.
 *
 * A task that came from an external source (Linear, Jira, GitHub, ...) has two
 * valid completions: close it in the source system, or close it only in 20x
 * because the user updates the source. This hook asks the user which one to
 * use, instead of always pushing the completion to the source.
 *
 * Tasks without a source complete immediately — there is nothing to ask.
 */
export function useTaskCompletion({ onToast }: UseTaskCompletionOptions = {}) {
  const updateTask = useTaskStore((s) => s.updateTask)
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

  /**
   * Applies the completion. When `atSource` is true the plugin action runs
   * first; a failure leaves the task open so the two systems stay in sync.
   */
  const runCompletion = useCallback(
    async (
      task: WorkfloTask,
      options: CompleteTaskRequestOptions | undefined,
      atSource: boolean
    ): Promise<boolean> => {
      try {
        if (atSource && task.source_id) {
          const actionField = task.output_fields.find((f) => f.id === 'action')
          const actionValue = actionField?.value
            ? String(actionField.value)
            : PluginActionId.Complete
          const result = await executeAction(actionValue, task.id, task.source_id)
          if (!result.success) {
            onToast?.(result.error || 'Failed to complete task', true)
            return false
          }
        }
        await updateTask(task.id, { status: TaskStatus.Completed })
      } catch (err) {
        console.error('Failed to complete task:', err)
        onToast?.('Failed to complete task', true)
        return false
      }

      options?.onCompleted?.(task)
      onToast?.(
        atSource
          ? `"${task.title}" completed`
          : `"${task.title}" completed in 20x only`
      )
      return true
    },
    [executeAction, onToast, updateTask]
  )

  /**
   * Entry point for every user-triggered completion. Reads the task from the
   * store so callers cannot pass a stale copy.
   */
  const requestComplete = useCallback(
    async (taskId: string, options?: CompleteTaskRequestOptions) => {
      const task = useTaskStore.getState().tasks.find((t) => t.id === taskId)
      if (!task) return
      if (task.source_id) {
        setPending({ taskId, options })
        return
      }
      await runCompletion(task, options, false)
    },
    [runCompletion]
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
        const done = await runCompletion(task, pending.options, atSource)
        if (done) setPending(null)
      } finally {
        setIsBusy(false)
      }
    },
    [isBusy, pending, runCompletion]
  )

  const handleCompleteAtSource = useCallback(() => resolvePending(true), [resolvePending])
  const handleCompleteManually = useCallback(() => resolvePending(false), [resolvePending])
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
