/**
 * Shared voice-control contracts (phase 1 — speech-to-text only).
 *
 * Blueprint: research subtask "FluidVoice + local voice integration feasibility"
 * (design.md §5). Phase 1 is dictation + validated task commands. Spoken (TTS)
 * answers, wake word, and cloud realtime providers are phase 2; the contracts
 * below reserve room for them but nothing in phase 1 emits audio.
 *
 * This module is imported by the main process, the preload bridge, the renderer
 * and the mobile client, so it must stay free of Node and DOM APIs.
 */

// ── Audio format ────────────────────────────────────────────

/** Every provider consumes 16 kHz mono signed 16-bit little-endian PCM. */
export const VOICE_SAMPLE_RATE = 16000
export const VOICE_CHANNELS_COUNT = 1
/** Renderer -> main audio chunk size. 20 ms of audio at 16 kHz. */
export const VOICE_FRAME_SAMPLES = 320
/** Hard cap on a single spoken turn. Protects memory and the model worker. */
export const VOICE_MAX_TURN_MS = 60_000

// ── State machine ───────────────────────────────────────────

export type VoiceState =
  | 'disabled'
  | 'permission_needed'
  | 'model_needed'
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'awaiting_confirmation'
  | 'executing'
  | 'waiting_for_agent'
  | 'speaking'
  | 'error'

/**
 * Allowed transitions. `error` and `idle` are reachable from every active
 * state (cancellation and failure), so they are not repeated in each row.
 */
export const VOICE_TRANSITIONS: Record<VoiceState, readonly VoiceState[]> = {
  disabled: ['permission_needed', 'model_needed', 'idle'],
  permission_needed: ['model_needed', 'idle', 'disabled'],
  model_needed: ['idle', 'permission_needed', 'disabled'],
  idle: ['listening', 'permission_needed', 'model_needed', 'disabled'],
  listening: ['transcribing', 'idle'],
  transcribing: ['awaiting_confirmation', 'executing', 'waiting_for_agent', 'idle'],
  awaiting_confirmation: ['executing', 'idle'],
  executing: ['waiting_for_agent', 'speaking', 'idle'],
  waiting_for_agent: ['speaking', 'idle'],
  speaking: ['idle'],
  error: ['idle', 'disabled'],
} as const

const ALWAYS_REACHABLE: readonly VoiceState[] = ['idle', 'error', 'disabled']

/** True when `to` is a legal next state after `from`. */
export function canTransition(from: VoiceState, to: VoiceState): boolean {
  if (from === to) return true
  if (ALWAYS_REACHABLE.includes(to)) return true
  return VOICE_TRANSITIONS[from].includes(to)
}

// ── Turn model ──────────────────────────────────────────────

/**
 * `dictation` never runs the intent parser: spoken words go to the focused text
 * control verbatim. `command` parses a closed intent set. Keeping the two modes
 * apart is what stops a dictated sentence from executing a task action.
 *
 * `conversation` is dictation that does not stop: the microphone stays open,
 * each pause ends a sentence, and the sentence is sent straight away. It never
 * runs the parser either, so it cannot execute a task action.
 */
export type VoiceTurnMode = 'dictation' | 'command' | 'conversation'

export interface VoiceTurnStart {
  turnId: string
  mode: VoiceTurnMode
  context: VoiceUiContext
}

/** What the renderer is showing when the turn starts. Main trusts nothing here. */
export interface VoiceUiContext {
  selectedTaskId?: string | null
  view?: VoiceViewName
  /** The approval visible on screen right now, if any. */
  pendingApproval?: { taskId: string; sessionId: string } | null
  /** Task IDs the user can currently see. Used only to rank candidates. */
  visibleTaskIds?: string[]
}

export type VoiceViewName = 'tasks' | 'skills' | 'dashboard' | 'canvas' | 'settings'

export const VOICE_VIEW_NAMES: readonly VoiceViewName[] = [
  'tasks',
  'skills',
  'dashboard',
  'canvas',
  'settings',
]

// ── Intents (closed union — see design §5.4) ────────────────

export type VoicePriority = 'critical' | 'high' | 'medium' | 'low'

export type VoiceIntent =
  | { type: 'create_task'; title: string; description?: string; priority?: VoicePriority }
  | { type: 'assign_agent'; taskRef: VoiceTargetRef; agentName: string }
  | { type: 'start_task'; taskRef: VoiceTargetRef }
  | { type: 'reply_to_agent'; taskRef: VoiceTargetRef; message: string }
  | { type: 'approve_checkpoint'; taskRef: VoiceTargetRef; message?: string }
  | { type: 'reject_checkpoint'; taskRef: VoiceTargetRef; message?: string }
  | { type: 'navigate'; destination: VoiceViewName; taskRef?: VoiceTargetRef }
  | { type: 'read_last_answer'; taskRef: VoiceTargetRef }
  | { type: 'cancel' }

export type VoiceIntentType = VoiceIntent['type']

export const VOICE_INTENT_TYPES: readonly VoiceIntentType[] = [
  'create_task',
  'assign_agent',
  'start_task',
  'reply_to_agent',
  'approve_checkpoint',
  'reject_checkpoint',
  'navigate',
  'read_last_answer',
  'cancel',
]

/**
 * An unresolved reference to a task. The parser never invents a task ID; main
 * resolves the reference against the database (design §5.6).
 */
export type VoiceTargetRef =
  | { kind: 'current' }
  | { kind: 'title'; text: string }
  | { kind: 'id'; id: string }

/** What the interpreter produced for one final transcript. */
export type VoiceInterpretation =
  | { kind: 'dictation'; text: string }
  | { kind: 'intent'; proposal: VoiceIntentProposal }
  | { kind: 'unrecognized'; transcript: string }

export interface VoiceIntentProposal {
  intent: VoiceIntent
  /** 0..1. Below `VOICE_CONFIRM_CONFIDENCE` the action always asks first. */
  confidence: number
  transcript: string
  source: 'deterministic' | 'classifier'
  /** One short line shown on the confirmation card. */
  summary: string
}

export const VOICE_CONFIRM_CONFIDENCE = 0.8

// ── Actions ─────────────────────────────────────────────────

/** Main -> renderer answer to one command turn. */
export type VoiceActionOutcome =
  /** Nothing ran. The renderer must show a confirmation card. */
  | {
      status: 'needs_confirmation'
      turnId: string
      proposal: VoiceIntentProposal
      /** Filled when the reference matched more than one record. */
      candidates?: VoiceCandidate[]
      reason: VoiceConfirmReason
    }
  | { status: 'executed'; turnId: string; intent: VoiceIntentType; message: string; taskId?: string }
  | { status: 'rejected'; turnId: string; reason: VoiceRejectReason; message: string }
  | { status: 'dictation'; turnId: string; text: string }
  | { status: 'cancelled'; turnId: string }

export interface VoiceCandidate {
  id: string
  label: string
  kind: 'task' | 'agent'
}

export type VoiceConfirmReason =
  | 'destructive'
  | 'ambiguous_task'
  | 'ambiguous_agent'
  | 'low_confidence'
  | 'policy'

export type VoiceRejectReason =
  | 'unrecognized'
  | 'no_target'
  | 'no_pending_approval'
  | 'not_found'
  | 'stale_turn'
  | 'failed'

/** At most this many choices are offered when a reference is ambiguous. */
export const VOICE_MAX_CANDIDATES = 3

// ── Engine / model status ───────────────────────────────────

export type VoiceEngineStatus =
  /** The local runtime is not installed. Voice stays disabled. */
  | { state: 'engine_missing'; message: string }
  /** The runtime is present but no speech model is downloaded yet. */
  | { state: 'model_missing'; message: string }
  | { state: 'loading' }
  | { state: 'ready'; modelId: string; engine: string }
  | { state: 'error'; message: string }

// ── Optional local runtime ──────────────────────────────────

/**
 * The local speech runtime is an optional install. It is not in the
 * application bundle, so a user who never turns voice on pays nothing for it,
 * and a missing runtime can never break the rest of the app.
 *
 * Until it is installed, every voice control is hidden.
 */
export interface VoiceRuntimeStatus {
  installed: boolean
  version: string | null
  /** Absolute path the worker loads. Null while the runtime is absent. */
  modulePath: string | null
  /** Approximate download size, shown before the user agrees. */
  sizeBytes: number
  installing?: boolean
  /** 0..1 */
  progress?: number
  error?: string
}

export interface VoiceRuntimeProgressEvent {
  stage: 'starting' | 'installing' | 'complete' | 'error'
  output: string
  /** 0..100, as npm reports nothing better. */
  percent: number
}

export interface VoiceModelFile {
  /** File name on disk inside the model directory. */
  name: string
  url: string
  /** Lower-case hex SHA-256. An empty value blocks the download (see below). */
  sha256: string
  sizeBytes: number
}

export interface VoiceModelManifestEntry {
  id: string
  label: string
  /** One line telling the user what this model is good for. */
  description: string
  /** BCP-47 tags the model covers. */
  languages: string[]
  /** SPDX identifier or a short licence name. Shown before the download. */
  license: string
  licenseUrl: string
  /** Refuse the download below this much free memory. */
  minMemoryBytes: number
  /**
   * Individual model files. Single files, not an archive, so nothing has to be
   * unpacked and every part is checksummed on its own.
   *
   * A checksum stays empty until the Phase 0 packaging spike measures it on
   * every supported platform. `VoiceModelManager` refuses to download an entry
   * with an empty checksum, so an unverified model can never reach a user.
   */
  files: VoiceModelFile[]
  /** Role of each file for the worker. Values are `files[].name` entries. */
  roles: { encoder: string; decoder: string; joiner: string; tokens: string }
}

export interface VoiceModelState {
  id: string
  label: string
  description: string
  license: string
  licenseUrl: string
  languages: string[]
  installed: boolean
  /** True for the model the worker uses. */
  active: boolean
  installing: boolean
  /** 0..1 */
  progress: number
  sizeBytes: number
  /** False when the manifest has no verified checksum yet. */
  downloadable: boolean
  error?: string
}

// ── Settings keys (stored in the `settings` table as strings) ──

export const VOICE_SETTING_KEYS = {
  enabled: 'voice_enabled',
  modelId: 'voice_model_id',
  quickCreate: 'voice_quick_create',
  globalShortcut: 'voice_global_shortcut',
  inputDeviceId: 'voice_input_device_id',
  /** Optional path to a speech model the user installed by hand. */
  customModelDir: 'voice_custom_model_dir',
  /** Keep the microphone open and send each sentence after a pause. */
  conversation: 'voice_conversation',
  /** Seconds of silence that end a sentence. */
  endpointSilence: 'voice_endpoint_silence',
} as const

export const VOICE_DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'

/** Seconds of silence that end a sentence in a conversation. */
export const VOICE_DEFAULT_ENDPOINT_SILENCE = 1.2
export const VOICE_ENDPOINT_SILENCE_CHOICES = [0.8, 1.2, 2] as const

/** A sentence shorter than this is treated as noise and is not sent. */
export const VOICE_MIN_SEGMENT_CHARS = 2

// ── IPC channel names ───────────────────────────────────────

export const VOICE_EVENTS = {
  /** `{ state, turnId? , detail? }` */
  state: 'voice:state',
  /** `{ turnId, text }` — replaces the previous partial for the same turn. */
  partial: 'voice:partial',
  /** `{ turnId, text }` */
  final: 'voice:final',
  /** One finished sentence in a conversation: `{ turnId, text, index }`. */
  segment: 'voice:segment',
  /** `VoiceActionOutcome` */
  outcome: 'voice:outcome',
  /** `{ message, code? }` */
  error: 'voice:error',
  /** `{ engine, models }` */
  status: 'voice:status',
  /** Main asks the renderer to move: `{ destination, taskId? }` */
  navigate: 'voice:navigate',
  /** Main asks the renderer to insert dictated text: `{ turnId, text }` */
  dictate: 'voice:dictate',
  /** Main asks the renderer to start/stop a push-to-talk turn from the hotkey. */
  hotkey: 'voice:hotkey',
  /** Progress of the optional runtime install. */
  runtimeProgress: 'voice:runtimeProgress',
} as const

export interface VoiceStateEvent {
  state: VoiceState
  turnId?: string | null
  detail?: string
}

export interface VoiceStatusEvent {
  enabled: boolean
  engine: VoiceEngineStatus
  models: VoiceModelState[]
  shortcut: string
  runtime: VoiceRuntimeStatus
}

/** Every field the renderer needs to draw the voice UI in one payload. */
export interface VoiceSnapshot extends VoiceStatusEvent {
  state: VoiceState
  turnId: string | null
  partial: string
  final: string
}

/** Microphone access as the operating system reports it. */
export type MicrophonePermission = 'granted' | 'denied' | 'not-determined' | 'unsupported'

// ── Capabilities (mobile gate — design §5.11) ───────────────

export interface VoiceCapabilities {
  /** False on mobile: phase 1 captures audio on the desktop host only. */
  available: boolean
  reason?: string
  /** Phase 2 flags. Kept here so clients never guess. */
  tts: boolean
  wakeWord: boolean
}

export const MOBILE_VOICE_CAPABILITIES: VoiceCapabilities = {
  available: false,
  reason: 'Voice control is available on desktop.',
  tts: false,
  wakeWord: false,
}
