/**
 * Peako is Mastermind with a face: a small always-on-top desktop window.
 *
 * The main window keeps owning the Mastermind session, voice and every store.
 * Peako's window only draws what the main window publishes and sends commands
 * back, relayed through the main process, so it stays light.
 */

export const PEAKO_DEFAULT_NAME = 'Peako'
export const PEAKO_NAME_MAX_LENGTH = 24

export const PEAKO_SETTING_KEYS = {
  enabled: 'peako_enabled',
  name: 'peako_name',
  position: 'peako_position'
} as const

/** The pseudo-task id the Mastermind session runs under (main uses the same literal). */
export const MASTERMIND_SESSION_ID = 'mastermind-session'

/** The agent Mastermind (and so Peako) runs on. Shared with the drawer. */
export const MASTERMIND_AGENT_SETTING = 'mastermind_agent_id'

export const PEAKO_CHANNELS = {
  /** main window → main: the latest state to draw */
  publishState: 'peako:publishState',
  /** main → Peako window */
  state: 'peako:state',
  layout: 'peako:layout',
  startRename: 'peako:startRename',
  /** Peako window → main */
  ready: 'peako:ready',
  command: 'peako:command',
  setExpanded: 'peako:setExpanded',
  dragMove: 'peako:dragMove',
  dragEnd: 'peako:dragEnd',
  contextMenu: 'peako:contextMenu',
  /** main → main window: a command for the Mastermind session */
  mainCommand: 'peako:mainCommand',
  /** main window → main */
  setEnabled: 'peako:setEnabled',
  getEnabled: 'peako:getEnabled'
} as const

export type PeakoMood =
  | 'idle'
  | 'working'
  | 'thinking'
  | 'needs'
  | 'party'
  | 'stuck'
  | 'listening'
  | 'speaking'
  | 'sleep'

export interface PeakoChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'question'
  text: string
  /** Answer choices when the agent asked a question. */
  options?: string[]
}

export interface PeakoAgentOption {
  id: string
  name: string
  model: string | null
}

/** Where a task sits in Peako's list, most urgent first. */
export type PeakoTaskGroup = 'needs' | 'running' | 'review' | 'next'

export interface PeakoTaskItem {
  id: string
  title: string
  group: PeakoTaskGroup
  agentName: string | null
}

/** The task open in Peako's mini chat. */
export interface PeakoTaskChat {
  id: string
  title: string
  group: PeakoTaskGroup
  agentName: string | null
  /** False when no agent is assigned, so there is nobody to message. */
  hasAgent: boolean
  working: boolean
  messages: PeakoChatMessage[]
  approval: { action: string; description: string } | null
}

export interface PeakoState {
  name: string
  mood: PeakoMood
  agents: PeakoAgentOption[]
  agentId: string | null
  /** True once the conversation has started; the agent is then fixed. */
  agentLocked: boolean
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  messages: PeakoChatMessage[]
  approval: { action: string; description: string } | null
  voice: {
    /** Voice is set up and switched on in Settings → Voice. */
    available: boolean
    listening: boolean
    speaking: boolean
    /** What the microphone is hearing right now. */
    partial: string
  }
  counts: { working: number; waiting: number; failed: number }
  /** A short line Peako says on its own, such as "A task finished". */
  bubble: string | null
  /** Open tasks, most urgent first, for browsing from Peako. */
  tasks: PeakoTaskItem[]
  /** The task open in the mini chat, if any. */
  taskChat: PeakoTaskChat | null
}

export type PeakoCommand =
  | { type: 'send'; text: string }
  | { type: 'approve'; approved: boolean }
  | { type: 'stop' }
  | { type: 'voice' }
  | { type: 'newChat' }
  | { type: 'setAgent'; agentId: string }
  | { type: 'rename'; name: string }
  | { type: 'openSettings'; tab?: 'general' | 'voice' }
  | { type: 'openApp' }
  | { type: 'hide' }
  /** Opens a task's mini chat; null closes it. */
  | { type: 'focusTask'; taskId: string | null }
  | { type: 'taskSend'; taskId: string; text: string }
  | { type: 'taskApprove'; taskId: string; approved: boolean }
  | { type: 'taskStop'; taskId: string }
  /** Shows the task in the 20x window. */
  | { type: 'openTask'; taskId: string }

/** What the main window receives: Peako's commands plus a few from main itself. */
export type PeakoMainCommand =
  | PeakoCommand
  | { type: 'requestState' }
  | { type: 'enabledChanged'; enabled: boolean }

export interface PeakoLayout {
  expanded: boolean
  /** Which side of the mascot the chat panel opens on. */
  panelSide: 'left' | 'right'
  /** True when the mascot sits at the top of the window and the panel hangs below. */
  mascotAtTop: boolean
}

/** Trims and limits a name; falls back to the default for an empty one. */
export function normalizePeakoName(name: string | null | undefined): string {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, PEAKO_NAME_MAX_LENGTH)
  return trimmed || PEAKO_DEFAULT_NAME
}

const COMMAND_TYPES = new Set<PeakoCommand['type']>([
  'send', 'approve', 'stop', 'voice', 'newChat', 'setAgent', 'rename', 'openSettings', 'openApp', 'hide',
  'focusTask', 'taskSend', 'taskApprove', 'taskStop', 'openTask'
])

const isTaskId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200

function isMessageText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 20_000
}

/** Structural guard for commands arriving over IPC from the Peako window. */
export function isPeakoCommand(value: unknown): value is PeakoCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Record<string, unknown>
  if (typeof command.type !== 'string' || !COMMAND_TYPES.has(command.type as PeakoCommand['type'])) return false
  switch (command.type) {
    case 'send':
      return isMessageText(command.text)
    case 'focusTask':
      return command.taskId === null || isTaskId(command.taskId)
    case 'taskSend':
      return isTaskId(command.taskId) && isMessageText(command.text)
    case 'taskApprove':
      return isTaskId(command.taskId) && typeof command.approved === 'boolean'
    case 'taskStop':
    case 'openTask':
      return isTaskId(command.taskId)
    case 'approve':
      return typeof command.approved === 'boolean'
    case 'setAgent':
      return typeof command.agentId === 'string' && command.agentId.length > 0
    case 'rename':
      return typeof command.name === 'string'
    case 'openSettings':
      return command.tab === undefined || command.tab === 'general' || command.tab === 'voice'
    default:
      return true
  }
}
