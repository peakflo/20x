import { create } from 'zustand'
import { settingsApi, voiceApi, voiceTtsApi } from '@/lib/ipc-client'
import { voiceCapture } from '@/lib/voice-capture'
import { voicePlayback } from '@/lib/voice-playback'
import { BargeInGate } from '@/lib/voice-barge-in'
import { clearActiveComposer } from '@/lib/voice-dictation-target'
import { VOICE_SETTING_KEYS } from '@shared/voice'
import type { VoiceTtsEngineId, VoiceTtsSnapshot } from '@shared/voice-tts'
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

  // ── Spoken answers ──────────────────────────────────────
  /** Null until the first snapshot arrives. */
  tts: VoiceTtsSnapshot | null
  speaking: boolean
  /**
   * The passage being spoken. Nothing draws it while it plays; the speak
   * button on a message reads it to know which message is the one being read.
   */
  speechText: string

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

  initializeTts: () => Promise<void>
  setTtsEnabled: (enabled: boolean) => Promise<void>
  setTtsEngine: (engine: VoiceTtsEngineId) => Promise<void>
  setTtsVoice: (voiceId: string) => Promise<void>
  setTtsSpeed: (speed: number) => Promise<void>
  setTtsMaxChars: (maxChars: number) => Promise<void>
  setTtsSpeakActionResults: (on: boolean) => Promise<void>
  setTtsOnlyVoiceTurns: (on: boolean) => Promise<void>
  installTtsModel: (id: string) => Promise<void>
  selectTtsModel: (id: string) => Promise<void>
  removeTtsModel: (id: string) => Promise<void>
  previewVoice: (voiceId: string) => Promise<void>
  speakText: (text: string, taskId?: string) => Promise<void>
  stopSpeaking: () => Promise<void>
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

/**
 * Spoken answers have their own gate.
 *
 * They do not need the microphone, the optional speech runtime or a downloaded
 * model, because the system voice needs none of them. A build with speech to
 * text switched off can still read an answer aloud.
 */
function hasTtsBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.voice?.tts?.getSnapshot === 'function'
}

/**
 * Holds the microphone back while an answer is being read, and releases it the
 * moment the user talks over it (design §5.7).
 *
 * There is one for the window, beside the single microphone and the single
 * speaker, so a turn and an answer can never disagree about who is talking.
 */
/**
 * The passage the user stopped.
 *
 * Main cannot stop instantly: the voice call blocks its process, so a `cancel`
 * is only read between sentences. Until then main keeps pushing, and each push
 * is another `speechStart` and more audio for the same passage. Naming what was
 * stopped is what makes the silence hold.
 */
let stoppedSpeechId: string | null = null

/**
 * Everything the renderer does when speech is stopped by the user: barge-in,
 * the stop button, Escape, and opening a turn. It has to be one function,
 * because a path that forgets one of these steps is a path where 20x carries
 * on talking.
 */
function stopPlaybackForUser(): void {
  stoppedSpeechId = voicePlayback.currentSpeechId ?? stoppedSpeechId
  voicePlayback.stop()
  // The gate is opened here as well. The `speechEnd` that follows names a
  // passage that is already gone and is dropped, so nothing else would open it,
  // and a gate left holding swallows every word into the open turn.
  bargeInGate.setSpeaking(false)
  useVoiceStore.setState({ speaking: false, speechText: '' })
}

const bargeInGate = new BargeInGate({
  onBargeIn: () => {
    // Stop in this tick, before the round trip to main: the user is already
    // speaking and every further word of the answer is talking over them.
    stopPlaybackForUser()
    void voiceTtsApi.stop()
  },
})

/** True when a voice is loaded and something can actually be spoken. */
export function selectSpeechReady(state: { tts: VoiceTtsSnapshot | null }): boolean {
  return state.tts?.status.state === 'ready'
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
  tts: null,
  speaking: false,
  speechText: '',

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
    // Barge-in. Playback stops here, in the same tick as the press, instead of
    // waiting for main to answer. Main stops producing the rest.
    stopPlaybackForUser()
    const started = await voiceApi.startTurn(mode, contextProvider?.() ?? {})
    if ('error' in started) {
      set({ result: { kind: 'error', message: started.error, at: Date.now() } })
      return
    }
    set({ turnId: started.turnId, mode, partial: '', final: '', result: null, sentSentences: [] })

    bargeInGate.reset()
    const ok = await voiceCapture.start({
      onAudio: (chunk) => {
        const id = get().turnId
        if (!id) return
        // Nothing reaches the recogniser while 20x is talking, so an answer can
        // never be transcribed as if the user had said it.
        for (const frame of bargeInGate.push(chunk)) void voiceApi.pushAudio(id, frame)
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
    // No composer is named, so the words are shown in settings and are
    // inserted nowhere.
    clearActiveComposer()
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
    bargeInGate.reset()
    // The turn is closed here and now. Waiting for an answer from main would
    // leave the control stuck on "Stop" whenever main has already dropped the
    // turn — for example after the worker ended it at a pause.
    set({ turnId: null, level: 0, partial: '' })
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
    bargeInGate.reset()
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

  // ── Spoken answers ────────────────────────────────────────

  initializeTts: async () => {
    if (!hasTtsBridge()) return
    set({ tts: await voiceTtsApi.getSnapshot() })
  },

  setTtsEnabled: async (enabled) => set({ tts: await voiceTtsApi.setEnabled(enabled) }),
  setTtsEngine: async (engine) => set({ tts: await voiceTtsApi.setEngine(engine) }),
  setTtsVoice: async (voiceId) => set({ tts: await voiceTtsApi.setVoice(voiceId) }),
  setTtsSpeed: async (speed) => set({ tts: await voiceTtsApi.setSpeed(speed) }),
  setTtsMaxChars: async (maxChars) => set({ tts: await voiceTtsApi.setMaxChars(maxChars) }),
  setTtsSpeakActionResults: async (on) => set({ tts: await voiceTtsApi.setSpeakActionResults(on) }),
  setTtsOnlyVoiceTurns: async (on) => set({ tts: await voiceTtsApi.setOnlyVoiceTurns(on) }),

  installTtsModel: async (id) => {
    try {
      set({ tts: await voiceTtsApi.installModel(id) })
    } catch (err) {
      set({
        result: { kind: 'error', message: err instanceof Error ? err.message : String(err), at: Date.now() },
      })
      await get().initializeTts()
    }
  },

  selectTtsModel: async (id) => set({ tts: await voiceTtsApi.selectModel(id) }),
  removeTtsModel: async (id) => set({ tts: await voiceTtsApi.removeModel(id) }),

  previewVoice: async (voiceId) => {
    const { spoken } = await voiceTtsApi.preview(voiceId)
    if (spoken) return
    set({
      result: { kind: 'error', message: 'That voice is not ready yet.', at: Date.now() },
    })
  },

  speakText: async (text, taskId) => {
    const { spoken } = await voiceTtsApi.speak(text, taskId)
    if (spoken) return
    set({ result: { kind: 'error', message: 'No voice is ready to read this.', at: Date.now() } })
  },

  stopSpeaking: async () => {
    stopPlaybackForUser()
    await voiceTtsApi.stop()
  },
}))

// ── Main-process events ─────────────────────────────────────

if (hasVoiceBridge()) {
  voiceApi.onState((event) => {
    // Main owns the state machine, so it is the authority on whether a turn is
    // open. When it reports idle, any turn the renderer still holds is gone —
    // release the microphone and clear it. Without this, one stranded turn
    // disables every microphone button in the app for ever.
    if (event.state === 'idle' && useVoiceStore.getState().turnId) {
      voiceCapture.stop()
      useVoiceStore.setState({ state: event.state, turnId: null, level: 0, partial: '' })
      return
    }
    useVoiceStore.setState({ state: event.state })
  })

  voiceApi.onPartial((event) => {
    if (event.turnId !== useVoiceStore.getState().turnId) return
    useVoiceStore.setState({ partial: event.text })
  })

  voiceApi.onFinal((event) => {
    useVoiceStore.setState({ final: event.text, partial: '' })
    // A turn also ends by itself: the worker closes it when the speaker pauses.
    // Release the microphone here too, or it would stay open with no way to
    // stop it from the user interface.
    if (useVoiceStore.getState().turnId === event.turnId) {
      voiceCapture.stop()
      useVoiceStore.setState({ turnId: null, level: 0 })
    }
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
    // `completed` closes a conversation whose sentences were already sent. It
    // is a normal ending, so it shows nothing.
    if (
      outcome.status === 'dictation' ||
      outcome.status === 'cancelled' ||
      outcome.status === 'completed'
    ) {
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

// ── Spoken answers ──────────────────────────────────────────

if (hasTtsBridge()) {
  voiceTtsApi.onSpeechStart((event) => {
    // The user stopped this passage. Main is still finishing the sentence it
    // was inside — a `cancel` can only be read between sentences — and its
    // next push arrives as another `speechStart`. Re-opening the passage here
    // let that sentence play out in full, which is 20x finishing its sentence
    // after being told to stop.
    if (event.speechId === stoppedSpeechId) return

    useVoiceStore.setState({ speaking: true, speechText: event.text })
    bargeInGate.setSpeaking(true)

    // Main announces the start on every push, not once per passage. Opening a
    // passage that is already open does nothing, so the sentence sounding now
    // is not cut off by the arrival of the next one.
    //
    // No `onLevel` handler is passed. Nothing draws the loudness of the
    // playback any more, and reporting it ran an analyser read and a store
    // write sixteen times a second for the whole of every answer.
    voicePlayback.start(event.speechId, {
      // The worker finishes producing before the last sentence finishes
      // playing, so the speaking state ends here and not on the end event.
      // The microphone stays held until this point.
      onDrained: () => {
        bargeInGate.setSpeaking(false)
        useVoiceStore.setState({ speaking: false, speechText: '' })
      },
    })
  })

  voiceTtsApi.onSpeechChunk((event) => {
    if (event.speechId === stoppedSpeechId) return
    voicePlayback.play(event.speechId, event.pcm, event.sampleRate)
  })

  voiceTtsApi.onSpeechEnd((event) => {
    // `complete` only means that nothing more will arrive. Whatever is queued
    // still has to be heard, so playback is left alone and `onDrained` ends it.
    //
    // Unless nothing was ever queued: a passage can finish having produced no
    // audio at all, and then no sentence will ever end to release the
    // microphone.
    if (event.reason === 'complete' && voicePlayback.hasQueuedAudio) return
    if (voicePlayback.currentSpeechId !== event.speechId) {
      // The event names a passage that is already gone. Nothing is sounding,
      // so nothing may still be held back from the recogniser.
      if (!voicePlayback.isPlaying) bargeInGate.setSpeaking(false)
      return
    }
    voicePlayback.stop()
    bargeInGate.setSpeaking(false)
    useVoiceStore.setState({ speaking: false, speechText: '' })
    if (event.reason === 'error' && event.message) {
      useVoiceStore.setState({ result: { kind: 'error', message: event.message, at: Date.now() } })
    }
  })

  voiceTtsApi.onStatus((snapshot) => useVoiceStore.setState({ tts: snapshot }))

  // One voice is 26 MB or 103 MB, so its progress arrives on its own and is
  // merged into the list rather than replacing the whole snapshot.
  voiceTtsApi.onModelProgress(({ model }) => {
    useVoiceStore.setState((state) =>
      state.tts
        ? {
            tts: {
              ...state.tts,
              models: state.tts.models.map((m) => (m.id === model.id ? { ...m, ...model } : m)),
            },
          }
        : state
    )
  })
}
