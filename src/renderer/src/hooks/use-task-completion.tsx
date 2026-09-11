import { useCallback } from 'react'
import { useTaskStore } from '@/stores/task-store'
import { dispatchShortcutFeedback } from '@/lib/keyboard-shortcuts'
import type { WorkfloTask } from '@/types'

export interface UseTaskCompletionOptions {
  onToast?: (message: string, isError?: boolean) => void
}
export interface CompleteTaskRequestOptions {
  onCompleted?: (task: WorkfloTask) => void
}

/** Task administration stops local work before asking the source to confirm completion. */
export function useTaskCompletion({ onToast = dispatchShortcutFeedback }: UseTaskCompletionOptions = {}) {
  const requestComplete = useCallback(async (taskId: string, options?: CompleteTaskRequestOptions) => {
    const task = useTaskStore.getState().tasks.find(t => t.id === taskId)
    if (!task) return
    try {
      const result = await window.electronAPI.db.manageScheduleTask(task.id, 'complete')
      if (result.cancelled) return
      if (!result.success) throw new Error(result.error || 'The server did not confirm completion.')
      await useTaskStore.getState().fetchTasks()
      options?.onCompleted?.(useTaskStore.getState().tasks.find(t => t.id === taskId) ?? task)
      onToast?.(`"${task.title}" completed`)
    } catch (error) {
      onToast?.(error instanceof Error ? error.message : 'Task completion failed.', true)
    }
  }, [onToast])
  return { requestComplete, completionDialog: null }
}
