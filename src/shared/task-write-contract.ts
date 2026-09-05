/** Human intent is explicit; the main process supplies the actual user credential. */
export const TASK_WRITE_HEADERS = { 'x-task-contract-version': '2', 'x-task-actor': 'human' } as const

export function taskCompletionCommand(taskId: string, outputs: Record<string, unknown>, expectedVersion: number) {
  return {
    method: 'POST' as const,
    path: `/api/tasks/${taskId}/action`,
    body: { outputs, expectedVersion },
    headers: TASK_WRITE_HEADERS
  }
}
