/**
 * Owner of the voice session in the main process (design §5.1 and §5.3).
 *
 * It holds the state machine, the turn identity, the worker lifecycle, the
 * model status, the global shortcut and the confirmation queue. The renderer
 * only captures audio and draws the result; every decision is made here.
 */

import { app, globalShortcut, systemPreferences } from 'electron'
import { join } from 'path'
import { createId } from '@paralleldrive/cuid2'
import {
  VOICE_DEFAULT_ENDPOINT_SILENCE,
  VOICE_DEFAULT_SHORTCUT,
  VOICE_EVENTS,
  VOICE_MIN_SEGMENT_CHARS,
  VOICE_SETTING_KEYS,
  canTransition,
  type VoiceActionOutcome,
  type VoiceEngineStatus,
  type VoiceIntent,
  type VoiceIntentProposal,
  type VoiceModelState,
  type VoiceSnapshot,
  type VoiceState,
  type VoiceTurnMode,
  type VoiceUiContext,
  type MicrophonePermission,
  type VoiceRuntimeStatus,
} from '../../shared/voice'
import { interpretTranscript } from '../../shared/voice-intent-parser'
import { VoiceModelManager } from './voice-model-manager'
import { DEFAULT_VOICE_MODEL_ID } from './voice-model-manifest'
import { VoiceWorkerClient } from './voice-worker-client'
import { VoiceActionService, type VoiceActionAgents, type VoiceActionDb } from './voice-action-service'
import {
  VOICE_RUNTIME_APPROX_BYTES,
  detectVoiceRuntime,
  installVoiceRuntime,
  removeVoiceRuntime,
} from './voice-runtime-installer'
import { VoiceSpeechService, type VoiceAnswerPart } from './voice-speech-service'
import type { VoiceTtsEngineId, VoiceTtsSnapshot } from '../../shared/voice-tts'

export interface VoiceSessionManagerOptions {
  db: VoiceActionDb & { setSetting: (key: string, value: string) => void }
  agents: VoiceActionAgents
  /** Broadcasts one event to the desktop renderer and to mobile clients. */
  notify: (channel: string, data: unknown) => void
  /**
   * Sends one event to the desktop renderer only. Speech audio uses this:
   * samples must never go through the mobile text channel (design §5.11).
   */
  notifyRenderer?: (channel: string, data: unknown) => void
  modelRootDir?: string
  /** Where the downloaded speech-synthesis models live. */
  ttsModelRootDir?: string
  /** Where the optional speech runtime is installed. */
  runtimeRootDir?: string
  worker?: VoiceWorkerClient
  /** Injected in tests so no real download runs. */
  models?: VoiceModelManager
  /** Injected in tests so no synthesis worker starts. */
  speech?: VoiceSpeechService
}

/** The runtime install is the first part of the combined setup progress. */
const RUNTIME_PERCENT = 60
const RUNTIME_SHARE = RUNTIME_PERCENT / 100

const RUNTIME_ABSENT: VoiceRuntimeStatus = {
  installed: false,
  version: null,
  modulePath: null,
  sizeBytes: VOICE_RUNTIME_APPROX_BYTES,
}

interface PendingConfirmation {
  proposal: VoiceIntentProposal
  context: VoiceUiContext
}

/**
 * How long a click waits for a model that is still loading.
 *
 * Generous: the largest catalogue model is 662 MB and a cold disk is slow.
 * Giving up early is what made a click do nothing.
 */
export const VOICE_ENGINE_READY_TIMEOUT_MS = 90_000

/**
 * How long a spoken question waits for its answer before the indicator returns
 * to rest. The answer itself is still spoken if it arrives later, because the
 * expectation lives longer than this timer.
 */
export const VOICE_ANSWER_WAIT_MS = 3 * 60 * 1000

export class VoiceSessionManager {
  private state: VoiceState = 'disabled'
  private turnId: string | null = null
  private turnMode: VoiceTurnMode = 'dictation'
  private turnContext: VoiceUiContext = {}
  private partial = ''
  private final = ''
  /** Sentences already delivered in the open turn. Reset with every turn. */
  private segmentsSent = 0
  private engine: VoiceEngineStatus = { state: 'model_missing', message: 'No speech model is installed yet.' }
  private pending = new Map<string, PendingConfirmation>()
  private registeredShortcut: string | null = null
  private runtime: VoiceRuntimeStatus = RUNTIME_ABSENT
  private setupPhase: 'model' | null = null
  private readonly runtimeRootDir: string

  private readonly models: VoiceModelManager
  private readonly worker: VoiceWorkerClient
  private readonly actions: VoiceActionService
  private readonly speech: VoiceSpeechService
  /** Stops `waiting_for_agent` lasting for ever when no answer arrives. */
  private answerTimer: NodeJS.Timeout | null = null

  constructor(private options: VoiceSessionManagerOptions) {
    this.models =
      options.models ??
      new VoiceModelManager({
        rootDir: options.modelRootDir ?? join(app.getPath('userData'), 'voice-models'),
        onProgress: (state) => this.onModelProgress(state),
      })
    this.runtimeRootDir = options.runtimeRootDir ?? join(app.getPath('userData'), 'voice-runtime')
    this.worker = options.worker ?? new VoiceWorkerClient()
    this.actions = new VoiceActionService({
      db: options.db,
      agents: options.agents,
      notify: options.notify,
    })

    this.worker.on('status', (status: VoiceEngineStatus) => this.onEngineStatus(status))
    this.worker.on('partial', (turnId: string, text: string) => this.onPartial(turnId, text))
    this.worker.on('segment', (turnId: string, text: string, index: number) =>
      this.onSegment(turnId, text, index)
    )
    this.worker.on('final', (turnId: string, text: string) => void this.onFinal(turnId, text))
    this.worker.on('error', (message: string, code?: string) => this.onWorkerError(message, code))

    this.speech =
      options.speech ??
      new VoiceSpeechService({
        db: options.db,
        modelRootDir: options.ttsModelRootDir ?? join(app.getPath('userData'), 'voice-tts-models'),
        // Audio goes to the desktop window only.
        notifyRenderer: options.notifyRenderer ?? options.notify,
      })
    // The state machine shows one audio state for the whole feature, so the
    // speaking indicator is the same indicator the microphone uses.
    this.speech.setSpeakingListener((speaking) => {
      if (speaking) {
        this.clearAnswerTimer()
        this.setState('speaking')
      } else if (this.state === 'speaking') {
        this.setState('idle')
      }
    })
  }

  // ── Lifecycle ─────────────────────────────────────────────

  /** Called once at start-up. Never throws: voice must not block the app. */
  async initialize(): Promise<void> {
    try {
      await this.refreshRuntime()
      // Spoken answers do not need the microphone, the speech runtime or a
      // downloaded model: the system voice needs none of them. So the speech
      // engine is prepared even when voice control itself is switched off.
      await this.speech.prepare()
      if (!this.isEnabled()) {
        this.setState('disabled')
        return
      }
      this.registerShortcut(this.shortcut())
      await this.prepareEngine()
    } catch (err) {
      console.error('[voice] initialize failed', err)
      this.setState('disabled')
    }
  }

  shutdown(): void {
    this.unregisterShortcut()
    this.clearAnswerTimer()
    this.worker.stop()
    this.speech.shutdown()
  }

  isEnabled(): boolean {
    return this.options.db.getSetting(VOICE_SETTING_KEYS.enabled) === 'true'
  }

  async setEnabled(enabled: boolean): Promise<VoiceSnapshot> {
    this.options.db.setSetting(VOICE_SETTING_KEYS.enabled, enabled ? 'true' : 'false')
    if (!enabled) {
      this.cancelTurn(this.turnId ?? undefined)
      this.unregisterShortcut()
      this.worker.stop()
      this.setState('disabled')
      return this.snapshot()
    }
    this.registerShortcut(this.shortcut())
    await this.refreshRuntime()
    await this.prepareEngine()
    return this.snapshot()
  }

  /** Loads the selected model when the runtime and a model are both present. */
  async prepareEngine(): Promise<void> {
    if (!this.runtime.installed) {
      this.engine = {
        state: 'engine_missing',
        message: 'The local speech runtime is not installed yet.',
      }
      this.setState('model_needed')
      void this.broadcastStatus()
      return
    }
    const resolved = await this.resolveModel()
    if (!resolved) {
      this.engine = { state: 'model_missing', message: 'No speech model is installed yet.' }
      this.setState('model_needed')
      void this.broadcastStatus()
      return
    }
    await this.worker.load(resolved, this.endpointSilenceSeconds())
  }

  /** How long a pause must be to end a sentence. */
  private endpointSilenceSeconds(): number {
    const raw = Number(this.options.db.getSetting(VOICE_SETTING_KEYS.endpointSilence))
    return Number.isFinite(raw) && raw > 0 ? raw : VOICE_DEFAULT_ENDPOINT_SILENCE
  }

  /** Applies a new pause length by reloading the model with it. */
  async setEndpointSilence(seconds: number): Promise<void> {
    this.cancelTurn()
    this.options.db.setSetting(VOICE_SETTING_KEYS.endpointSilence, String(seconds))
    this.worker.unload()
    await this.prepareEngine()
    await this.broadcastStatus()
  }

  // ── Permissions (design §5.9) ─────────────────────────────

  getMicrophonePermission(): MicrophonePermission {
    if (process.platform !== 'darwin') return 'unsupported'
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted' || status === 'denied' || status === 'not-determined') return status
    return 'unsupported'
  }

  async requestMicrophonePermission(): Promise<MicrophonePermission> {
    if (process.platform !== 'darwin') return 'unsupported'
    const granted = await systemPreferences.askForMediaAccess('microphone')
    return granted ? 'granted' : 'denied'
  }

  /**
   * Waits for a model that is on its way.
   *
   * Resolves as soon as the worker reports ready, and gives up on any other
   * outcome so a broken load cannot hold a click open for ever.
   */
  private awaitEngineReady(timeoutMs = VOICE_ENGINE_READY_TIMEOUT_MS): Promise<boolean> {
    if (this.engine.state === 'ready') return Promise.resolve(true)
    if (this.engine.state !== 'loading') return Promise.resolve(false)

    return new Promise((resolve) => {
      const settle = (ready: boolean): void => {
        clearTimeout(timer)
        this.worker.off('status', onStatus)
        resolve(ready)
      }
      const onStatus = (status: VoiceEngineStatus): void => {
        if (status.state === 'loading') return
        settle(status.state === 'ready')
      }
      const timer = setTimeout(() => settle(false), timeoutMs)
      this.worker.on('status', onStatus)
    })
  }

  // ── Turns ─────────────────────────────────────────────────

  /** Opens a turn and returns its ID. A new turn always cancels the old one. */
  async startTurn(
    mode: VoiceTurnMode,
    context: VoiceUiContext
  ): Promise<{ turnId: string } | { error: string }> {
    if (!this.isEnabled()) return { error: 'Voice is switched off.' }
    // Barge-in (design §5.7). The moment the user speaks, 20x stops speaking.
    this.speech.stop('cancelled')
    // The worker releases the model after an idle period to give the memory
    // back. Load it again instead of failing, or voice would stop working
    // silently after a few minutes of quiet.
    if (!this.worker.isLoaded) await this.prepareEngine()
    // Loading a model takes seconds — the largest is 662 MB. `prepareEngine`
    // only asks for it; the worker answers later. Failing here because the
    // answer had not arrived yet meant a click did nothing at all, every time
    // the model had been released: after the idle unload, after a restart,
    // after a model change.
    if (this.engine.state === 'loading') await this.awaitEngineReady()
    if (this.engine.state !== 'ready') {
      return { error: engineMessage(this.engine) }
    }
    if (this.turnId) this.cancelTurn(this.turnId)

    const turnId = createId()
    this.turnId = turnId
    this.turnMode = mode
    this.turnContext = context ?? {}
    this.partial = ''
    this.final = ''
    this.segmentsSent = 0
    this.worker.startTurn(turnId, mode)
    this.setState('listening')
    return { turnId }
  }

  pushAudio(turnId: string, frame: Buffer): void {
    // Audio from an old turn is dropped, so a late frame cannot pollute a new
    // transcript.
    if (turnId !== this.turnId) return
    this.worker.pushAudio(frame)
  }

  endTurn(turnId: string): void {
    if (turnId !== this.turnId) return
    this.setState('transcribing')
    this.worker.endTurn(turnId)
  }

  cancelTurn(turnId?: string): void {
    const id = turnId ?? this.turnId
    if (!id) return
    if (this.turnId === id) {
      this.turnId = null
      this.partial = ''
      this.segmentsSent = 0
      this.setState('idle')
    }
    this.pending.delete(id)
    this.worker.cancelTurn(id)
    this.options.notify(VOICE_EVENTS.outcome, { status: 'cancelled', turnId: id } satisfies VoiceActionOutcome)
  }

  // ── Worker events ─────────────────────────────────────────

  /**
   * One finished sentence inside an open conversation. The microphone stays
   * open, so the state stays `listening` and the next sentence follows.
   *
   * A conversation never runs the intent parser, exactly like dictation, so a
   * spoken sentence cannot execute a task action.
   */
  private onSegment(turnId: string, text: string, index: number): void {
    if (turnId !== this.turnId) return
    const words = text.trim()
    // Very short output is noise, not a sentence. Sending it would be worse
    // than dropping it, because the renderer submits it straight away.
    if (words.length < VOICE_MIN_SEGMENT_CHARS) return
    this.partial = ''
    this.segmentsSent += 1
    this.options.notify(VOICE_EVENTS.segment, { turnId, text: words, index })
  }

  private onPartial(turnId: string, text: string): void {
    if (turnId !== this.turnId) return
    this.partial = text
    this.options.notify(VOICE_EVENTS.partial, { turnId, text })
  }

  private async onFinal(turnId: string, text: string): Promise<void> {
    if (turnId !== this.turnId) return
    this.final = text
    this.partial = ''
    this.options.notify(VOICE_EVENTS.final, { turnId, text })

    const mode = this.turnMode
    const context = this.turnContext
    const delivered = this.segmentsSent
    this.turnId = null
    this.segmentsSent = 0

    if (!text.trim()) {
      this.setState('idle')
      if (delivered > 0) {
        // Ending a conversation is not a failure. Every sentence already left
        // as a segment, and the recogniser was reset after each one, so this
        // closing transcript is empty by design.
        this.options.notify(VOICE_EVENTS.outcome, {
          status: 'completed',
          turnId,
          segments: delivered,
        } satisfies VoiceActionOutcome)
        return
      }
      this.options.notify(VOICE_EVENTS.outcome, {
        status: 'rejected',
        turnId,
        reason: 'unrecognized',
        message: 'Nothing was heard.',
      } satisfies VoiceActionOutcome)
      return
    }

    const interpretation = interpretTranscript(text, mode)
    if (interpretation.kind === 'dictation') {
      this.setState('idle')
      this.options.notify(VOICE_EVENTS.dictate, { turnId, text: interpretation.text })
      this.options.notify(VOICE_EVENTS.outcome, {
        status: 'dictation',
        turnId,
        text: interpretation.text,
      } satisfies VoiceActionOutcome)
      return
    }
    if (interpretation.kind === 'unrecognized') {
      this.setState('idle')
      this.options.notify(VOICE_EVENTS.outcome, {
        status: 'rejected',
        turnId,
        reason: 'unrecognized',
        // Naming the mode is the missing half: this only happens on the
        // global shortcut, and the user has no way to know that.
        message: `“${interpretation.transcript}” is not one of the spoken commands. To dictate it instead, use the microphone beside a message box.`,
      } satisfies VoiceActionOutcome)
      return
    }

    await this.runProposal(turnId, interpretation.proposal, context, false)
  }

  private onEngineStatus(status: VoiceEngineStatus): void {
    this.engine = status
    if (status.state === 'ready') {
      if (this.state === 'disabled' || this.state === 'model_needed' || this.state === 'error') {
        this.setState('idle')
      }
    } else if (status.state === 'engine_missing' || status.state === 'model_missing') {
      this.setState('model_needed')
    } else if (status.state === 'error') {
      this.setState('error')
    }
    void this.broadcastStatus()
  }

  private onWorkerError(message: string, code?: string): void {
    if (this.turnId) {
      this.options.notify(VOICE_EVENTS.outcome, {
        status: 'rejected',
        turnId: this.turnId,
        reason: 'failed',
        message,
      } satisfies VoiceActionOutcome)
      this.turnId = null
    }
    this.options.notify(VOICE_EVENTS.error, { message, code })
    this.setState('idle')
  }

  // ── Confirmation queue ────────────────────────────────────

  private async runProposal(
    turnId: string,
    proposal: VoiceIntentProposal,
    context: VoiceUiContext,
    confirmed: boolean
  ): Promise<void> {
    this.setState(confirmed ? 'executing' : 'transcribing')
    const outcome = await this.actions.apply(turnId, proposal, context, confirmed)

    if (outcome.status === 'needs_confirmation') {
      this.pending.set(turnId, { proposal: outcome.proposal, context })
      this.setState('awaiting_confirmation')
      this.options.notify(VOICE_EVENTS.outcome, outcome)
      return
    }
    this.pending.delete(turnId)
    // The card is shown before the speech starts, so the user reads the result
    // even when nothing is spoken.
    this.options.notify(VOICE_EVENTS.outcome, outcome)
    await this.afterExecuted(turnId, outcome)
  }

  /**
   * What happens to a finished command (design §5.7).
   *
   * A question to the agent has no answer yet, so the turn waits. Everything
   * else has its short result spoken, if the user asked for that.
   */
  private async afterExecuted(turnId: string, outcome: VoiceActionOutcome): Promise<void> {
    if (outcome.status !== 'executed') {
      this.setState('idle')
      return
    }

    if (outcome.intent === 'reply_to_agent' && outcome.taskId) {
      // Remember which turn asked, so the answer that arrives minutes later is
      // matched to this turn and no other agent answer is read out.
      this.speech.expectAnswer(outcome.taskId, turnId)
      this.setState('waiting_for_agent')
      this.armAnswerTimer(outcome.taskId)
      return
    }

    const source = outcome.intent === 'read_last_answer' ? 'read_last_answer' : 'action_result'
    const spoken = await this.speech.speak({
      text: outcome.message,
      source,
      voiceTurnId: turnId,
      ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
    })
    // `speak` moves the state to `speaking` itself when it starts.
    if (!spoken) this.setState('idle')
  }

  /**
   * The user spoke a sentence and it was sent to an agent.
   *
   * This is what closes the loop in a conversation: the answer that comes back
   * is read aloud, exactly as it is for a spoken command. `taskId` is absent
   * when the sender does not know it — the Mastermind drawer sends on its own
   * behalf — and then the next answer to arrive is taken as the reply.
   */
  expectSpokenAnswer(turnId: string, taskId?: string): void {
    if (taskId) this.speech.expectAnswer(taskId, turnId)
    else this.speech.expectAnyAnswer(turnId)
  }

  /**
   * The agent is writing an answer. Reads it aloud as it arrives.
   *
   * Called for every transcript change, so it must be cheap and must decide for
   * itself whether this answer may be spoken at all.
   */
  async streamAgentAnswer(taskId: string, parts: VoiceAnswerPart[]): Promise<void> {
    if (parts.length === 0) return
    if (this.speech.streamingTaskId !== taskId) {
      if (!(await this.speech.beginStreamingAnswer(taskId))) return
    }
    this.speech.pushStreamingAnswer(taskId, parts)
  }

  /** The agent has stopped. Reads out whatever is left of the answer. */
  finishAgentAnswer(taskId: string, parts: VoiceAnswerPart[]): boolean {
    if (this.speech.streamingTaskId !== taskId) return false
    this.speech.pushStreamingAnswer(taskId, parts, true)
    this.speech.endStreamingAnswer(taskId)
    return true
  }

  /** Speaks one finished agent answer. Called from the agent status stream. */
  async speakAgentAnswer(taskId: string, text: string): Promise<boolean> {
    const spoken = await this.speech.speakAgentAnswer(taskId, text)
    if (!spoken && this.state === 'waiting_for_agent') this.setState('idle')
    return spoken
  }

  /**
   * A question that is never answered must not leave the indicator waiting for
   * ever.
   */
  private armAnswerTimer(taskId: string): void {
    this.clearAnswerTimer()
    this.answerTimer = setTimeout(() => {
      this.speech.forgetAnswer(taskId)
      if (this.state === 'waiting_for_agent') this.setState('idle')
    }, VOICE_ANSWER_WAIT_MS)
    this.answerTimer.unref?.()
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer) clearTimeout(this.answerTimer)
    this.answerTimer = null
  }

  /**
   * Runs a proposal the user confirmed on screen. `choice` carries the record
   * the user picked when the spoken reference matched more than one.
   */
  async confirm(turnId: string, choice?: { taskId?: string; agentName?: string }): Promise<void> {
    const entry = this.pending.get(turnId)
    if (!entry) {
      this.options.notify(VOICE_EVENTS.outcome, {
        status: 'rejected',
        turnId,
        reason: 'stale_turn',
        message: 'That request is no longer active.',
      } satisfies VoiceActionOutcome)
      return
    }
    this.pending.delete(turnId)
    const proposal = choice ? applyChoice(entry.proposal, choice) : entry.proposal
    await this.runProposal(turnId, proposal, entry.context, true)
  }

  /** The user dismissed the confirmation card. Nothing runs. */
  dismiss(turnId: string): void {
    this.pending.delete(turnId)
    this.setState('idle')
    this.options.notify(VOICE_EVENTS.outcome, { status: 'cancelled', turnId } satisfies VoiceActionOutcome)
  }

  // ── Optional runtime ──────────────────────────────────────

  getRuntime(): VoiceRuntimeStatus {
    return this.runtime
  }

  /** Reads what is installed and points the worker at it. */
  async refreshRuntime(): Promise<VoiceRuntimeStatus> {
    this.runtime = await detectVoiceRuntime(this.runtimeRootDir)
    this.worker.setRuntimeModulePath(this.runtime.modulePath)
    // The neural voice uses the same runtime. The system voice does not, so it
    // keeps working whatever this reports.
    this.speech.setRuntimeModulePath(this.runtime.modulePath)
    return this.runtime
  }

  // ── Spoken answers (design §5.7) ──────────────────────────

  ttsSnapshot(): Promise<VoiceTtsSnapshot> {
    return this.speech.snapshot()
  }

  setTtsEnabled(enabled: boolean): Promise<VoiceTtsSnapshot> {
    return this.speech.setEnabled(enabled)
  }

  setTtsEngine(engine: VoiceTtsEngineId): Promise<VoiceTtsSnapshot> {
    return this.speech.setEngine(engine)
  }

  setTtsVoice(voiceId: string): Promise<VoiceTtsSnapshot> {
    return this.speech.setVoice(voiceId)
  }

  setTtsSpeed(speed: number): Promise<VoiceTtsSnapshot> {
    return this.speech.setSpeed(speed)
  }

  setTtsMaxChars(maxChars: number): Promise<VoiceTtsSnapshot> {
    return this.speech.setMaxChars(maxChars)
  }

  setTtsSpeakActionResults(on: boolean): Promise<VoiceTtsSnapshot> {
    return this.speech.setSpeakActionResults(on)
  }

  setTtsOnlyVoiceTurns(on: boolean): Promise<VoiceTtsSnapshot> {
    return this.speech.setOnlyVoiceTurns(on)
  }

  installTtsModel(id: string): Promise<VoiceTtsSnapshot> {
    return this.speech.installModel(id)
  }

  selectTtsModel(id: string): Promise<VoiceTtsSnapshot> {
    return this.speech.selectModel(id)
  }

  removeTtsModel(id: string): Promise<VoiceTtsSnapshot> {
    return this.speech.removeModel(id)
  }

  /** Plays one short sample in the speaker the user is looking at. */
  speakPreview(voiceId: string): Promise<boolean> {
    return this.speech.speak({
      text: 'This is how 20x will read an answer to you.',
      source: 'preview',
      voiceId,
    })
  }

  /** The speak button on one message. */
  speakText(text: string, taskId?: string): Promise<boolean> {
    return this.speech.speak({ text, source: 'manual', ...(taskId ? { taskId } : {}) })
  }

  stopSpeaking(): void {
    this.speech.stop('cancelled')
  }

  /**
   * One action installs everything voice needs: the speech runtime and, if none
   * is present yet, the default speech model. It runs only after the user asks
   * for it, and the model is loaded at the end, so nothing else is left to do
   * by hand.
   *
   * The runtime is the first 60 % of the reported progress, the model the rest.
   */
  async installRuntime(): Promise<VoiceRuntimeStatus> {
    this.runtime = { ...this.runtime, installing: true, progress: 0, error: undefined }
    this.emitSetupProgress('starting', 'Preparing…\n', 0)

    try {
      if (!(await detectVoiceRuntime(this.runtimeRootDir)).installed) {
        await installVoiceRuntime(this.runtimeRootDir, (progress) => {
          // Never report 'complete' here: the model still has to arrive.
          const stage = progress.stage === 'complete' ? 'installing' : progress.stage
          this.emitSetupProgress(stage, progress.output, Math.round(progress.percent * RUNTIME_SHARE))
        })
      }
      await this.refreshRuntime()

      // Without a model the runtime can do nothing, so fetch the default one.
      if (!(await this.resolveModel())) {
        this.setupPhase = 'model'
        this.emitSetupProgress('installing', 'Downloading the English speech model…\n', RUNTIME_PERCENT)
        try {
          await this.models.install(DEFAULT_VOICE_MODEL_ID)
          this.options.db.setSetting(VOICE_SETTING_KEYS.modelId, DEFAULT_VOICE_MODEL_ID)
        } finally {
          this.setupPhase = null
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setupPhase = null
      this.runtime = { ...(await detectVoiceRuntime(this.runtimeRootDir)), error: message }
      this.emitSetupProgress('error', `${message}\n`, 100)
      await this.broadcastStatus()
      throw err
    }

    await this.prepareEngine()
    this.emitSetupProgress('complete', 'Voice control is ready.\n', 100)
    await this.broadcastStatus()
    return this.runtime
  }

  /** Reports one progress line for the combined runtime + model setup. */
  private emitSetupProgress(
    stage: 'starting' | 'installing' | 'complete' | 'error',
    output: string,
    percent: number
  ): void {
    this.runtime = {
      ...this.runtime,
      installing: stage !== 'complete' && stage !== 'error',
      progress: percent / 100,
    }
    this.options.notify(VOICE_EVENTS.runtimeProgress, { stage, output, percent })
  }

  /** The model paths the worker needs, or null when nothing usable is present. */
  private resolveModel(): ReturnType<VoiceModelManager['resolve']> {
    const modelId = this.options.db.getSetting(VOICE_SETTING_KEYS.modelId) || DEFAULT_VOICE_MODEL_ID
    const customDir = this.options.db.getSetting(VOICE_SETTING_KEYS.customModelDir) || undefined
    return this.models.resolve(modelId, customDir)
  }

  /** Deletes the runtime and switches voice off, because it cannot run. */
  async removeRuntime(): Promise<VoiceRuntimeStatus> {
    this.worker.stop()
    await removeVoiceRuntime(this.runtimeRootDir)
    await this.refreshRuntime()
    this.engine = {
      state: 'engine_missing',
      message: 'The local speech runtime is not installed yet.',
    }
    this.setState(this.isEnabled() ? 'model_needed' : 'disabled')
    await this.broadcastStatus()
    return this.runtime
  }

  // ── Models ────────────────────────────────────────────────

  /** The model the worker uses, whether or not it is downloaded yet. */
  activeModelId(): string {
    return this.options.db.getSetting(VOICE_SETTING_KEYS.modelId) || DEFAULT_VOICE_MODEL_ID
  }

  listModels(): Promise<VoiceModelState[]> {
    return this.models.list(this.activeModelId())
  }

  /** Switches the model the worker uses. It must already be downloaded. */
  async selectModel(id: string): Promise<VoiceModelState[]> {
    // The worker is about to swap models, so any open turn is void.
    this.cancelTurn()
    this.options.db.setSetting(VOICE_SETTING_KEYS.modelId, id)
    // A hand-installed directory would win over the choice, so it is cleared.
    this.options.db.setSetting(VOICE_SETTING_KEYS.customModelDir, '')
    this.worker.unload()
    await this.prepareEngine()
    await this.broadcastStatus()
    return this.listModels()
  }

  async installModel(id: string): Promise<VoiceModelState> {
    this.cancelTurn()
    const state = await this.models.install(id)
    this.options.db.setSetting(VOICE_SETTING_KEYS.modelId, id)
    await this.prepareEngine()
    return state
  }

  async removeModel(id: string): Promise<VoiceModelState[]> {
    this.cancelTurn()
    await this.models.remove(id)
    if (this.activeModelId() === id) {
      // Fall back to another model that is on disk, so voice keeps working.
      const remaining = (await this.models.list()).find((m) => m.installed && m.id !== id)
      this.options.db.setSetting(VOICE_SETTING_KEYS.modelId, remaining?.id ?? DEFAULT_VOICE_MODEL_ID)
      this.worker.unload()
    }
    await this.prepareEngine()
    await this.broadcastStatus()
    return this.listModels()
  }

  async removeAllModels(): Promise<void> {
    await this.models.removeAll()
    this.worker.stop()
    this.engine = { state: 'model_missing', message: 'No speech model is installed yet.' }
    this.setState(this.isEnabled() ? 'model_needed' : 'disabled')
    await this.broadcastStatus()
  }

  async setCustomModelDir(dir: string): Promise<VoiceSnapshot> {
    this.options.db.setSetting(VOICE_SETTING_KEYS.customModelDir, dir)
    await this.prepareEngine()
    return this.snapshot()
  }

  private onModelProgress(state: VoiceModelState): void {
    this.options.notify(VOICE_EVENTS.status, { model: state })
    if (this.setupPhase !== 'model') return
    // Fold the model download into the single setup progress bar.
    this.emitSetupProgress(
      'installing',
      '',
      RUNTIME_PERCENT + Math.round(state.progress * (100 - RUNTIME_PERCENT))
    )
  }

  // ── Global shortcut (design §5.8) ─────────────────────────

  shortcut(): string {
    return this.options.db.getSetting(VOICE_SETTING_KEYS.globalShortcut) || VOICE_DEFAULT_SHORTCUT
  }

  /**
   * Registers a toggle accelerator. Electron cannot report a global key
   * release, so phase 1 uses a toggle here and a true press-and-hold only
   * inside the app window.
   */
  registerShortcut(accelerator: string): boolean {
    this.unregisterShortcut()
    if (!accelerator) return false
    try {
      const ok = globalShortcut.register(accelerator, () => {
        this.options.notify(VOICE_EVENTS.hotkey, { action: 'toggle' })
      })
      if (ok) this.registeredShortcut = accelerator
      return ok
    } catch (err) {
      console.error('[voice] shortcut registration failed', err)
      return false
    }
  }

  async setShortcut(accelerator: string): Promise<VoiceSnapshot> {
    this.options.db.setSetting(VOICE_SETTING_KEYS.globalShortcut, accelerator)
    if (this.isEnabled()) this.registerShortcut(accelerator)
    return this.snapshot()
  }

  private unregisterShortcut(): void {
    if (!this.registeredShortcut) return
    try {
      globalShortcut.unregister(this.registeredShortcut)
    } catch {
      /* the accelerator was already released */
    }
    this.registeredShortcut = null
  }

  // ── State and snapshots ───────────────────────────────────

  private setState(next: VoiceState, detail?: string): void {
    if (!canTransition(this.state, next)) {
      console.warn(`[voice] blocked transition ${this.state} -> ${next}`)
      return
    }
    if (this.state === next) return
    this.state = next
    this.options.notify(VOICE_EVENTS.state, { state: next, turnId: this.turnId, detail })
  }

  getState(): VoiceState {
    return this.state
  }

  async snapshot(): Promise<VoiceSnapshot> {
    return {
      enabled: this.isEnabled(),
      engine: this.engine,
      models: await this.listModels(),
      shortcut: this.shortcut(),
      runtime: this.runtime,
      state: this.state,
      turnId: this.turnId,
      partial: this.partial,
      final: this.final,
    }
  }

  private async broadcastStatus(): Promise<void> {
    this.options.notify(VOICE_EVENTS.status, await this.snapshot())
  }
}

/** Replaces a spoken reference with the record the user picked. */
function applyChoice(
  proposal: VoiceIntentProposal,
  choice: { taskId?: string; agentName?: string }
): VoiceIntentProposal {
  let intent: VoiceIntent = proposal.intent
  if (choice.taskId && 'taskRef' in intent) {
    intent = { ...intent, taskRef: { kind: 'id', id: choice.taskId } } as VoiceIntent
  }
  if (choice.agentName && intent.type === 'assign_agent') {
    intent = { ...intent, agentName: choice.agentName }
  }
  return { ...proposal, intent, confidence: 1 }
}

function engineMessage(engine: VoiceEngineStatus): string {
  switch (engine.state) {
    case 'engine_missing':
    case 'model_missing':
    case 'error':
      return engine.message
    case 'loading':
      return 'The speech model is still loading.'
    default:
      return 'Voice is not ready.'
  }
}
