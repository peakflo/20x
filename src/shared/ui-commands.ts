/**
 * Commands that drive the desktop window from outside the renderer.
 *
 * An agent asks for these through MCP tools; the main process validates what it
 * can and pushes one command down `UI_COMMAND_CHANNEL`. The renderer applies it
 * to the stores. The channel carries **intent**, never a store mutation, so the
 * renderer stays the only place that knows how a view is assembled.
 *
 * Every command is addressed by task ID, never by panel ID or element. A panel
 * is rebuilt when a session starts, so a panel ID an agent read a minute ago
 * may already be gone.
 */

/** The places a user can be sent. `settings` is a pane, not a sidebar view. */
export const UI_VIEW_NAMES = ['dashboard', 'tasks', 'canvas', 'skills', 'settings'] as const
export type UiViewName = (typeof UI_VIEW_NAMES)[number]

/** Where a task can be opened. `auto` is resolved in main from the open view. */
export const UI_OPEN_TASK_TARGETS = ['auto', 'workspace', 'canvas', 'modal'] as const
export type UiOpenTaskTarget = (typeof UI_OPEN_TASK_TARGETS)[number]

/** What the canvas viewport can be told to do. */
export const UI_CANVAS_VIEW_MODES = ['fit_all', 'reset', 'zoom'] as const
export type UiCanvasViewMode = (typeof UI_CANVAS_VIEW_MODES)[number]

export const UI_COMMAND_CHANNEL = 'ui:command'
/** The renderer answers every command on this channel, with the same request ID. */
export const UI_COMMAND_RESULT_CHANNEL = 'ui:commandResult'

/**
 * How long main waits for the window to confirm a command.
 *
 * Opening a completed task loads it from the database first, and a viewport
 * change waits for the canvas to lay out, so this is generous. A window that
 * says nothing in this time is reported as a failure, never as a success.
 */
export const UI_COMMAND_TIMEOUT_MS = 5000

/** The zoom range the canvas itself enforces. Kept here so main can refuse early. */
export const UI_CANVAS_MIN_ZOOM = 0.1
export const UI_CANVAS_MAX_ZOOM = 3

export type UiCommand =
  | { kind: 'navigate'; view: UiViewName; settingsTab?: string }
  | { kind: 'open_task'; taskId: string; where: Exclude<UiOpenTaskTarget, 'auto'> }
  | { kind: 'move_task_panel'; taskId: string; x: number; y: number }
  | { kind: 'close_task_panel'; taskId: string }
  | { kind: 'set_canvas_view'; mode: UiCanvasViewMode; zoom?: number }
  | { kind: 'open_artifact'; taskId: string; artifactId: string }

/** One command as it travels to the window: the renderer echoes `requestId` back. */
export interface UiCommandEnvelope {
  requestId: string
  command: UiCommand
}

/** What the renderer did with one command. Reported back for the tool result. */
export interface UiCommandResult {
  applied: boolean
  /** Short, user-facing reason when nothing happened. */
  detail?: string
}

/**
 * The renderer's answer to one command: the outcome plus the screen right after
 * it, so the next `get_ui_state` already shows what the command did.
 */
export interface UiCommandAck extends UiCommandResult {
  requestId: string
  state?: UiStateSnapshot
}

/** A canvas panel as an agent sees it: addressed by task, not by panel ID. */
export interface UiCanvasPanelSummary {
  panelId: string
  type: string
  taskId: string | null
  title: string
  x: number
  y: number
  width: number
  height: number
}

export interface UiCanvasSummary {
  viewport: { x: number; y: number; zoom: number }
  panels: UiCanvasPanelSummary[]
}

/** The published screen. `get_ui_state` returns this plus `available`. */
export interface UiStateSnapshot {
  view: string
  modal: string | null
  selectedTaskId: string | null
  selectedTaskTitle: string | null
  dashboardPreviewTaskId: string | null
  mastermindOpen: boolean
  settingsTab: string | null
  waitingForYou: boolean
  visibleTaskIds: string[]
  canvas: UiCanvasSummary
}

/** How many panels are published. A canvas can hold more; a reply should not. */
export const UI_MAX_PUBLISHED_PANELS = 50

export function isUiViewName(value: unknown): value is UiViewName {
  return typeof value === 'string' && (UI_VIEW_NAMES as readonly string[]).includes(value)
}

export function isUiCanvasViewMode(value: unknown): value is UiCanvasViewMode {
  return typeof value === 'string' && (UI_CANVAS_VIEW_MODES as readonly string[]).includes(value)
}

export function isUiOpenTaskTarget(value: unknown): value is UiOpenTaskTarget {
  return typeof value === 'string' && (UI_OPEN_TASK_TARGETS as readonly string[]).includes(value)
}
