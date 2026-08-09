import { create } from 'zustand'
import { voiceApi } from '@/lib/ipc-client'
import { voiceCapture } from '@/lib/voice-capture'
import type {
  MicrophonePermission,
  VoiceActionOutcome,
  VoiceCandidate,
  VoiceConfirmReason,
  VoiceEngineStatus,
  VoiceIntentProposal,
  VoiceModelState,
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

interface VoiceStoreState {
  available: boolean
  enabled: boolean
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
  /** Set by the component that should receive dictated text. */
  contextProvider: (() => VoiceUiContext) | null

  initialize: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setContextProvider: (provider: (() => VoiceUiContext) | null) => void
  startTurn: (mode: VoiceTurnMode) => Promise<void>
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
  removeAllModels: () => Promise<void>
  setCustomModelDir: (dir: string) => Promise<void>
  setShortcut: (accelerator: string) => Promise<void>
}

const IDLE_ENGINE: VoiceEngineStatus = { state: 'model_missing', message: 'No speech model is installed yet.' }

function hasVoiceBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.voice?.getSnapshot === 'function'
}

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  available: hasVoiceBridge(),
  enabled: false,
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
  contextProvider: null,

  initialize: async () => {
    if (!hasVoiceBridge()) {
      set({ available: false })
      return
    }
    const [snapshot, permission] = await Promise.all([voiceApi.getSnapshot(), voiceApi.getPermission()])
    set({
      available: true,
      enabled: snapshot.enabled,
      state: snapshot.state,
      engine: snapshot.engine,
      models: snapshot.models,
      shortcut: snapshot.shortcut,
      permission: permission.status,
    })
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
      voiceCapture.stop()
    }
    const snapshot = await voiceApi.setEnabled(enabled)
    set({
      enabled: snapshot.enabled,
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
    set({ turnId: started.turnId, mode, partial: '', final: '', result: null })

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
    await voiceApi.removeModel(id)
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
    }))
    if (event.model) {
      useVoiceStore.setState((state) => ({
        models: state.models.map((m) => (m.id === event.model?.id ? { ...m, ...event.model } : m)),
      }))
    }
  })

  voiceApi.onError((event) => {
    useVoiceStore.setState({ result: { kind: 'error', message: event.message, at: Date.now() } })
  })
}
