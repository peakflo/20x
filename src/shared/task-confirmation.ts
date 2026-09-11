export type TaskConfirmation = { id: string; title: string; detail: string; confirmLabel: string }

export type TaskConfirmationApi = {
  current: () => Promise<TaskConfirmation | null>
  answer: (id: string, approved: boolean) => Promise<void>
  onChanged: (callback: (request: TaskConfirmation | null) => void) => () => void
}
