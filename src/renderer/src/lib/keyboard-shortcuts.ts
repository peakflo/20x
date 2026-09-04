export enum TaskShortcutAction {
  RUN = 'run',
  SNOOZE = 'snooze',
  OPEN_DETAILS = 'open_details',
  OPEN_CHANGES = 'open_changes',
  OPEN_OUTPUT = 'open_output',
  OPEN_ARTIFACT = 'open_artifact',
  OPEN_PR = 'open_pr',
  COPY_PR_URL = 'copy_pr_url',
  COPY_PR_BRANCH = 'copy_pr_branch'
}

const TASK_SHORTCUT_EVENT = '20x:task-shortcut'
const SHORTCUT_FEEDBACK_EVENT = '20x:shortcut-feedback'

export interface TaskShortcutDetail {
  action: TaskShortcutAction
  taskId: string
}

export const KEYBOARD_SHORTCUT_GROUPS = [
  {
    label: 'Navigation',
    shortcuts: [
      { keys: ['J'], label: 'Next visible task' },
      { keys: ['K'], label: 'Previous visible task' },
      { keys: ['Enter'], label: 'Open selected task' },
      { keys: ['Esc'], label: 'Close or clear selection' },
      { keys: ['G', 'D'], label: 'Go to Dashboard' },
      { keys: ['G', 'C'], label: 'Open selected task on Canvas or go to Canvas' },
      { keys: ['G', 'P'], label: 'Go to parent task' },
      { keys: ['G', 'T'], label: 'Go to Tasks' },
      { keys: ['G', 'S'], label: 'Go to Skills' },
      { keys: ['/'], label: 'Focus search' },
      { keys: ['Cmd/Ctrl', 'K'], label: 'Open command palette' },
      { keys: ['Cmd/Ctrl', '1–4'], label: 'Switch main view' }
    ]
  },
  {
    label: 'Task actions',
    shortcuts: [
      { keys: ['C'], label: 'Create task' },
      { keys: ['E'], label: 'Complete selected task' },
      { keys: ['H'], label: 'Snooze selected task' },
      { keys: ['R'], label: 'Run or resume selected task' },
      { keys: ['W'], label: 'Nudge agent to continue' },
      { keys: ['Shift', 'H'], label: 'Run heartbeat now' },
      { keys: ['#'], label: 'Delete selected task' },
      { keys: ['?'], label: 'Show keyboard shortcuts' }
    ]
  },
  {
    label: 'Task panels',
    shortcuts: [
      { keys: ['O', 'D'], label: 'Open Details' },
      { keys: ['O', 'C'], label: 'Open Changes' },
      { keys: ['O', 'O'], label: 'Open Output' },
      { keys: ['O', 'A'], label: 'Open newest artifact' },
      { keys: ['O', 'P'], label: 'Open newest pull request' },
      { keys: ['O', 'S'], label: 'Choose a subtask to open' },
      { keys: ['Y', 'P'], label: 'Copy pull-request URL' },
      { keys: ['Y', 'B'], label: 'Copy pull-request branch' }
    ]
  },
  {
    label: 'Audio',
    shortcuts: [
      { keys: ['V', 'T'], label: 'Toggle task audio' },
      { keys: ['V', 'M'], label: 'Toggle Mastermind audio' }
    ]
  }
] as const

const NUDGE_MESSAGES = [
  'Keep going and take the next useful step.',
  'Continue from where you stopped.',
  'Carry on until the task is ready.',
  'Please keep working toward completion.'
] as const
let nudgeMessageIndex = 0

export function getNextNudgeMessage(): string {
  const message = NUDGE_MESSAGES[nudgeMessageIndex % NUDGE_MESSAGES.length]
  nudgeMessageIndex += 1
  return message
}

export function isKeyboardInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT', 'WEBVIEW'].includes(target.tagName)
    || !!target.closest('[contenteditable="true"], .xterm')
}

export function dispatchTaskShortcut(detail: TaskShortcutDetail): void {
  window.dispatchEvent(new CustomEvent<TaskShortcutDetail>(TASK_SHORTCUT_EVENT, { detail }))
}

export function onTaskShortcut(listener: (detail: TaskShortcutDetail) => void): () => void {
  const handleEvent = (event: Event) => listener((event as CustomEvent<TaskShortcutDetail>).detail)
  window.addEventListener(TASK_SHORTCUT_EVENT, handleEvent)
  return () => window.removeEventListener(TASK_SHORTCUT_EVENT, handleEvent)
}

export function dispatchShortcutFeedback(message: string, isError = false): void {
  window.dispatchEvent(new CustomEvent(SHORTCUT_FEEDBACK_EVENT, { detail: { message, isError } }))
}

export function onShortcutFeedback(listener: (detail: { message: string; isError: boolean }) => void): () => void {
  const handleEvent = (event: Event) => listener((event as CustomEvent<{ message: string; isError: boolean }>).detail)
  window.addEventListener(SHORTCUT_FEEDBACK_EVENT, handleEvent)
  return () => window.removeEventListener(SHORTCUT_FEEDBACK_EVENT, handleEvent)
}
