import { CompleteAtSourceDialog } from '@/components/tasks/CompleteAtSourceDialog'
import { getTaskCompletionAction } from '@shared/task-completion'
import { useCallback, useState } from 'react'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

export interface UseTaskCompletionOptions {
  onToast?: (message: string, isError?: boolean) => void
}
export interface CompleteTaskRequestOptions {
  completeAtSource?: boolean
  onCompleted?: (task: WorkfloTask) => void
}

/** Ask before a source write; a manual completion changes only the local task. */
export function useTaskCompletion({ onToast }: UseTaskCompletionOptions = {}) {
  const [pending, setPending] = useState<{ taskId: string; options?: CompleteTaskRequestOptions } | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const sources = useTaskSourceStore(s => s.sources)
  const tasks = useTaskStore(s => s.tasks)
  const executeAction = useTaskSourceStore(s => s.executeAction)
  const requestComplete = useCallback(async (taskId: string, options?: CompleteTaskRequestOptions) => {
    const task = useTaskStore.getState().tasks.find(t => t.id === taskId)
    if (!task) return
    if (task.source_id && options?.completeAtSource === undefined) {
      setPending({ taskId, options })
      return
    }
    setIsBusy(true)
    try {
      if (!task.source_id || options?.completeAtSource === false) {
        await useTaskStore.getState().updateTask(task.id, { status: TaskStatus.Completed, ...(task.source_id ? { complete_at_source: false } : {}) })
        const completedTask = { ...task, status: TaskStatus.Completed }
        setPending(null)
        options?.onCompleted?.(completedTask)
        onToast?.(`"${task.title}" completed`)
        return
      }
      await useTaskStore.getState().updateTask(task.id, { complete_at_source: true })
      const action = getTaskCompletionAction(task.output_fields)
      const result = await executeAction(action, task.id, task.source_id)
      if (!result.success) throw new Error(result.error || 'The server did not confirm completion.')
      await useTaskStore.getState().fetchTasks()
      setPending(null)
      options?.onCompleted?.(task)
      onToast?.(`"${task.title}" completed`)
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : 'Task completion failed.', true)
    } finally {
      setIsBusy(false)
    }
  }, [executeAction, onToast])
  const pendingTask = tasks.find(task => task.id === pending?.taskId)
  const completionDialog = pendingTask && pending ? <CompleteAtSourceDialog
    isOpen={true}
    taskTitle={pendingTask.title}
    sourceName={sources.find(source => source.id === pendingTask.source_id)?.name || pendingTask.source || 'the task source'}
    isBusy={isBusy}
    onCompleteAtSource={() => void requestComplete(pending.taskId, { ...pending.options, completeAtSource: true })}
    onCompleteManually={() => void requestComplete(pending.taskId, { ...pending.options, completeAtSource: false })}
    onCancel={() => setPending(null)}
  /> : null
  return { requestComplete, completionDialog }
}
