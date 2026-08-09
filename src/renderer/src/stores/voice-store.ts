import { create } from 'zustand'
import { settingsApi, voiceApi } from '@/lib/ipc-client'
import { voiceCapture } from '@/lib/voice-capture'
import { clearDictationTarget } from '@/lib/voice-dictation-target'
import { VOICE_SETTING_KEYS } from '@shared/voice'
import type {
  MicrophonePermission,
  VoiceActionOutcome,
  VoiceCandidate,
  VoiceConfirmReason,
  VoiceEngineStatus,
  VoiceIntentProposal,
  VoiceModelState,
  VoiceRuntimeStatus,
  VoiceState,
  VoiceTurnMode,
  VoiceUiContext,
} from '@shared/voice'

/**
 * Renderer-side view of the voice session (design §5.3).
 *
 * The main process owns the state machine. This store mirrors it, owns the
 * microphone, and holds the confirmation card that the user must accept before
 * a task action runs.
 */

export interface VoiceConfirmation {
  turnId: string
  proposal: VoiceIntentProposal
  reason: VoiceConfirmReason
  candidates?: VoiceCandidate[]
}

export interface VoiceResultNotice {
  kind: 'ok' | 'error'
  message: string
  at: number
}

export interface VoiceRuntimeInstall {
  running: boolean
  percent: number
  /** The last few npm lines, so a failure is readable. */
  log: string
  error: string | null
}

interface VoiceStoreState {
  available: boolean
  enabled: boolean
  /** The optional local speech runtime. Voice UI stays hidden without it. */
  runtime: VoiceRuntimeStatus
  install: VoiceRuntimeInstall
  state: VoiceState
  engine: VoiceEngineStatus
  models: VoiceModelState[]
  shortcut: string
  permission: MicrophonePermission
  turnId: string | null
  mode: VoiceTurnMode
  partial: string
  final: string
  level: number
  confirmation: VoiceConfirmation | null
  result: VoiceResultNotice | null
  /** What the microphone heard during a test in settings. */
  testTranscript: string
  /** Keep the microphone open and send each sentence after a pause. */
  conversation: boolean
  /** Sentences already sent in the open conversation, newest last. */
  sentSentences: string[]
  /** Set by the component that should receive dictated text. */
  contextProvider: (() => VoiceUiContext) | null

  initialize: () => Promise<void>
  refreshRuntime: () => Promise<VoiceRuntimeStatus>
  installRuntime: () => Promise<boolean>
  removeRuntime: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setContextProvider: (provider: (() => VoiceUiContext) | null) => void
  startTurn: (mode: VoiceTurnMode) => Promise<void>
  /** Records one turn and shows the words in settings, changing nothing else. */
  startTest: () => Promise<void>
  clearTest: () => void
  setConversation: (on: boolean) => Promise<void>
  endTurn: () => Promise<void>
  toggleTurn: (mode: VoiceTurnMode) => Promise<void>
  cancel: () => Promise<void>
  confirm: (choice?: { taskId?: string; agentName?: string }) => Promise<void>
  dismiss: () => Promise<void>
  clearResult: () => void
  refresh: () => Promise<void>
  requestPermission: () => Promise<MicrophonePermission>
  installModel: (id: string) => Promise<void>
  removeModel: (id: string) => Promise<void>
  selectModel: (id: string) => Promise<void>
  removeAllModels: () => Promise<void>
  setCustomModelDir: (dir: string) => Promise<void>
  setShortcut: (accelerator: string) => Promise<void>
}

const IDLE_ENGINE: VoiceEngineStatus = { state: 'model_missing', message: 'No speech model is installed yet.' }

const RUNTIME_ABSENT: VoiceRuntimeStatus = {
  installed: false,
  version: null,
  modulePath: null,
  sizeBytes: 0,
}

const NO_INSTALL: VoiceRuntimeInstall = { running: false, percent: 0, log: '', error: null }

/**
 * Voice is usable only when the optional runtime is installed, a speech model
 * is loaded, and the user turned voice on. Every voice control in the app hides
 * unless this is true, so nothing is shown that cannot work.
 */
export function selectVoiceReady(state: {
  available: boolean
  enabled: boolean
  runtime: VoiceRuntimeStatus
  engine: VoiceEngineStatus
}): boolean {
  return state.available && state.enabled && state.runtime.installed && state.engine.state === 'ready'
}

/** True when the runtime and a speech model are both in place. */
export function selectVoiceSetupComplete(state: {
  runtime: VoiceRuntimeStatus
  models: VoiceModelState[]
  engine: VoiceEngineStatus
}): boolean {
  if (!state.runtime.installed) return false
  return state.engine.state === 'ready' || state.models.some((m) => m.installed)
}

function hasVoiceBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.voice?.getSnapshot === 'function'
}

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  available: hasVoiceBridge(),
  enabled: false,
  runtime: RUNTIME_ABSENT,
  install: NO_INSTALL,
  state: 'disabled',
  engine: IDLE_ENGINE,
  models: [],
  shortcut: '',
  permission: 'not-determined',
  turnId: null,
  mode: 'dictation',
  partial: '',
  final: '',
  level: 0,
  confirmation: null,
  result: null,
  testTranscript: '',
  conversation: true,
  sentSentences: [],
  contextProvider: null,

  initialize: async () => {
    if (!hasVoiceBridge()) {
      set({ available: false })
      return
    }
    const [snapshot, permission, conversation] = await Promise.all([
      voiceApi.getSnapshot(),
      voiceApi.getPermission(),
      settingsApi.get(VOICE_SETTING_KEYS.conversation),
    ])
    set({
      // Conversational is the default; only an explicit 'false' turns it off.
      conversation: conversation !== 'false',
      available: true,
      enabled: snapshot.enabled,
      runtime: snapshot.runtime ?? RUNTIME_ABSENT,
      state: snapshot.state,
      engine: snapshot.engine,
      models: snapshot.models,
      shortcut: snapshot.shortcut,
      permission: permission.status,
    })
  },

  refreshRuntime: async () => {
    if (!hasVoiceBridge()) return RUNTIME_ABSENT
    const runtime = await voiceApi.getRuntime()
    set({ runtime })
    return runtime
  },

  installRuntime: async () => {
    set({ install: { running: true, percent: 0, log: '', error: null } })
    try {
      const runtime = await voiceApi.installRuntime()
      set({ runtime, install: { ...NO_INSTALL } })
      await get().refresh()
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((state) => ({ install: { ...state.install, running: false, error: message } }))
      return false
    }
  },

  removeRuntime: async () => {
    const runtime = await voiceApi.removeRuntime()
    set({ runtime, install: { ...NO_INSTALL } })
    await get().refresh()
  },

  setEnabled: async (enabled) => {
    // Ask for the microphone only after the user switches voice on (design §5.9).
    if (enabled) {
      const current = await voiceApi.getPermission()
      let status = current.status
      if (status === 'not-determined') status = (await voiceApi.requestPermission()).status
      set({ permission: status })
      if (status === 'denied') {
        set({
          result: {
            kind: 'error',
            message: 'Microphone access is blocked. Allow it in the system privacy settings.',
            at: Date.now(),
          },
        })
        return
      }
    } else {
      void voiceCapture.release()
    }
    const snapshot = await voiceApi.setEnabled(enabled)
    set({
      enabled: snapshot.enabled,
      runtime: snapshot.runtime ?? get().runtime,
      state: snapshot.state,
      engine: snapshot.engine,
      models: snapshot.models,
      shortcut: snapshot.shortcut,
    })
  },

  setContextProvider: (contextProvider) => set({ contextProvider }),

  startTurn: async (mode) => {
    const { enabled, turnId, contextProvider } = get()
    if (!enabled || turnId) return
    const started = await voiceApi.startTurn(mode, contextProvider?.() ?? {})
    if ('error' in started) {
      set({ result: { kind: 'error', message: started.error, at: Date.now() } })
      return
    }
    set({ turnId: started.turnId, mode, partial: '', final: '', result: null, sentSentences: [] })

    const ok = await voiceCapture.start({
      onAudio: (chunk) => {
        const id = get().turnId
        if (id) void voiceApi.pushAudio(id, chunk)
      },
      onLevel: (level) => set({ level }),
      onError: (message) => {
        set({ result: { kind: 'error', message, at: Date.now() } })
        void get().cancel()
      },
    })
    if (!ok) {
      await voiceApi.cancelTurn(started.turnId)
      set({ turnId: null })
    }
  },

  startTest: async () => {
    // No target, so the words are shown in settings and inserted nowhere.
    clearDictationTarget()
    set({ testTranscript: '' })
    await get().startTurn('dictation')
  },

  clearTest: () => set({ testTranscript: '' }),

  setConversation: async (on) => {
    set({ conversation: on })
    await settingsApi.set(VOICE_SETTING_KEYS.conversation, on ? 'true' : 'false')
  },

  endTurn: async () => {
    const { turnId } = get()
    if (!turnId) return
    voiceCapture.stop()
    set({ level: 0 })
    await voiceApi.endTurn(turnId)
  },

  toggleTurn: async (mode) => {
    if (get().turnId) {
      await get().endTurn()
      return
    }
    await get().startTurn(mode)
  },

  cancel: async () => {
    const { turnId } = get()
    voiceCapture.stop()
    set({ turnId: null, partial: '', level: 0 })
    if (turnId) await voiceApi.cancelTurn(turnId)
  },

  confirm: async (choice) => {
    const confirmation = get().confirmation
    if (!confirmation) return
    set({ confirmation: null })
    await voiceApi.confirm(confirmation.turnId, choice)
  },

  dismiss: async () => {
    const confirmation = get().confirmation
    if (!confirmation) return
    set({ confirmation: null })
    await voiceApi.dismiss(confirmation.turnId)
  },

  clearResult: () => set({ result: null }),

  refresh: async () => {
    if (!hasVoiceBridge()) return
    const snapshot = await voiceApi.getSnapshot()
    set({
      enabled: snapshot.enabled,
      runtime: snapshot.runtime ?? RUNTIME_ABSENT,
      state: snapshot.state,
      engine: snapshot.engine,
      models: snapshot.models,
      shortcut: snapshot.shortcut,
    })
  },

  requestPermission: async () => {
    const { status } = await voiceApi.requestPermission()
    set({ permission: status })
    return status
  },

  installModel: async (id) => {
    try {
      await voiceApi.installModel(id)
    } catch (err) {
      set({
        result: { kind: 'error', message: err instanceof Error ? err.message : String(err), at: Date.now() },
      })
    }
    await get().refresh()
  },

  removeModel: async (id) => {
    set({ models: await voiceApi.removeModel(id) })
    await get().refresh()
  },

  selectModel: async (id) => {
    set({ models: await voiceApi.selectModel(id) })
    await get().refresh()
  },

  removeAllModels: async () => {
    await voiceApi.removeAllModels()
    await get().refresh()
  },

  setCustomModelDir: async (dir) => {
    const snapshot = await voiceApi.setCustomModelDir(dir)
    set({ engine: snapshot.engine, state: snapshot.state, models: snapshot.models })
  },

  setShortcut: async (accelerator) => {
    const snapshot = await voiceApi.setShortcut(accelerator)
    set({ shortcut: snapshot.shortcut })
  },
}))

// ── Main-process events ─────────────────────────────────────

if (hasVoiceBridge()) {
  voiceApi.onState((event) => useVoiceStore.setState({ state: event.state }))

  voiceApi.onPartial((event) => {
    if (event.turnId !== useVoiceStore.getState().turnId) return
    useVoiceStore.setState({ partial: event.text })
  })

  voiceApi.onFinal((event) => {
    useVoiceStore.setState({ final: event.text, partial: '' })
  })

  voiceApi.onOutcome((outcome: VoiceActionOutcome) => {
    if (outcome.status === 'needs_confirmation') {
      useVoiceStore.setState({
        confirmation: {
          turnId: outcome.turnId,
          proposal: outcome.proposal,
          reason: outcome.reason,
          ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
        },
        turnId: null,
      })
      return
    }
    if (outcome.status === 'executed') {
      useVoiceStore.setState({
        result: { kind: 'ok', message: outcome.message, at: Date.now() },
        turnId: null,
      })
      return
    }
    if (outcome.status === 'rejected') {
      useVoiceStore.setState({
        result: { kind: 'error', message: outcome.message, at: Date.now() },
        turnId: null,
      })
      return
    }
    if (outcome.status === 'cancelled') {
      useVoiceStore.setState({ turnId: null, partial: '' })
    }
  })

  voiceApi.onStatus((event) => {
    useVoiceStore.setState((state) => ({
      engine: event.engine ?? state.engine,
      models: event.models ?? state.models,
      enabled: event.enabled ?? state.enabled,
      shortcut: event.shortcut ?? state.shortcut,
      runtime: event.runtime ?? state.runtime,
    }))
    if (event.model) {
      useVoiceStore.setState((state) => ({
        models: state.models.map((m) => (m.id === event.model?.id ? { ...m, ...event.model } : m)),
      }))
    }
  })

  voiceApi.onRuntimeProgress((event) => {
    useVoiceStore.setState((state) => ({
      install: {
        running: event.stage !== 'complete' && event.stage !== 'error',
        percent: event.percent,
        // Keep the tail only: the log is a hint, not a full transcript.
        log: `${state.install.log}${event.output}`.slice(-4000),
        error: event.stage === 'error' ? event.output.trim() : state.install.error,
      },
    }))
  })

  voiceApi.onError((event) => {
    useVoiceStore.setState({ result: { kind: 'error', message: event.message, at: Date.now() } })
  })
}
