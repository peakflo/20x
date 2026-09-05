import { useCallback } from 'react'
import { useTaskSourceStore } from '@/stores/task-source-store'
import { useTaskStore } from '@/stores/task-store'
import { PluginActionId } from '@/types'
import type { WorkfloTask } from '@/types'

export interface UseTaskCompletionOptions {
  onToast?: (message: string, isError?: boolean) => void
}
export interface CompleteTaskRequestOptions {
  onCompleted?: (task: WorkfloTask) => void
}

/** Completion is confirmed by the server. Local dismissal is a view action. */
export function useTaskCompletion({ onToast }: UseTaskCompletionOptions = {}) {
  const executeAction = useTaskSourceStore(s => s.executeAction)
  const requestComplete = useCallback(async (taskId: string, options?: CompleteTaskRequestOptions) => {
    const task = useTaskStore.getState().tasks.find(t => t.id === taskId)
    if (!task) return
    try {
      if (!task.source_id) throw new Error('Send this task to Workflo before completing it.')
      const action = task.output_fields.find(f => f.id === 'action')?.value
      const result = await executeAction(action ? String(action) : PluginActionId.Complete, task.id, task.source_id)
      if (!result.success) throw new Error(result.error || 'The server did not confirm completion.')
      await useTaskStore.getState().fetchTasks()
      options?.onCompleted?.(task)
      onToast?.(`"${task.title}" completed`)
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : 'Task completion failed.', true)
    }
  }, [executeAction, onToast])
  return { requestComplete, completionDialog: null }
}
