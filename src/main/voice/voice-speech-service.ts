/**
 * Spoken answers (design §5.7).
 *
 * This service owns everything about speaking: what may be spoken, which voice
 * says it, the correlation that stops 20x reading out an unrelated background
 * answer, and the cancellation that stops it the moment the user talks.
 *
 * It never decides *what the agent said*. It receives a passage and a reason,
 * and the reason alone decides whether the passage is spoken.
 *
 * Audio goes to the desktop renderer only. It is never broadcast to the mobile
 * clients: the audio is produced on this computer, a phone cannot play a raw
 * PCM stream from a local WebSocket, and sending it would put a megabyte of
 * samples through a text channel for nothing (design §5.11).
 */

import { createId } from '@paralleldrive/cuid2'
import {
  VOICE_TTS_DEFAULT_MAX_CHARS,
  VOICE_TTS_DEFAULT_SPEED,
  VOICE_TTS_EVENTS,
  VOICE_TTS_HARD_MAX_CHARS,
  VOICE_TTS_SETTING_KEYS,
  clampSpeechSpeed,
  isVoiceTtsEngineId,
  splitIntoSentences,
  splitStreamingSentences,
  toSpokenText,
  withShortLeadIn,
  type VoiceSpeechEndEvent,
  type VoiceSpeechRequest,
  type VoiceSpeechStartEvent,
  type VoiceTtsEngineId,
  type VoiceTtsSnapshot,
  type VoiceTtsStatus,
  type VoiceTtsVoice,
} from '../../shared/voice-tts'
import {
  DEFAULT_TTS_SPEAKER_BY_MODEL,
  DEFAULT_VOICE_TTS_MODEL_ID,
  VOICE_TTS_MODEL_MANIFEST,
  findTtsManifestEntry,
} from './voice-tts-manifest'
import { VoiceTtsModelManager } from './voice-tts-model-manager'
import { VoiceTtsWorkerClient, type VoiceTtsChunk } from './voice-tts-worker-client'
import { listSystemVoices, pickDefaultSystemVoice, systemVoiceName } from './voice-system-voices'

/**
 * One message of an agent answer.
 *
 * A turn can hold several: the agent says something, uses a tool, and says
 * something else. Each is read, in the order it was written.
 */
export interface VoiceAnswerPart {
  partId: string
  content: string
}

export interface VoiceSpeechSettings {
  getSetting: (key: string) => string | undefined
  setSetting: (key: string, value: string) => void
}

export interface VoiceSpeechServiceOptions {
  db: VoiceSpeechSettings
  /** Sends one event to the desktop renderer. Never to a mobile client. */
  notifyRenderer: (channel: string, data: unknown) => void
  models?: VoiceTtsModelManager
  worker?: VoiceTtsWorkerClient
  /** Injected in tests so no machine command runs. */
  listVoices?: typeof listSystemVoices
}

/**
 * An answer expected because the user asked a question by voice.
 *
 * Without this, a background agent that finishes an hour later would be read
 * out over whatever the user is doing.
 */
interface AnswerExpectation {
  taskId: string
  voiceTurnId: string
  expiresAt: number
}

/** An expected answer is forgotten after this long. */
export const VOICE_ANSWER_EXPECTATION_MS = 10 * 60 * 1000

/**
 * How long an answer is expected when the task it will come from is not known
 * yet.
 *
 * A sentence spoken into the Mastermind drawer is sent by the drawer itself, so
 * the renderer has no task to name. The window is short on purpose: it is armed
 * only by the user speaking, and it is consumed by the first answer to arrive.
 */
export const VOICE_ANY_ANSWER_EXPECTATION_MS = 90 * 1000

/** How many tasks keep a record of the messages the user talked over. */
export const VOICE_SILENCED_TASKS = 32
/** And how many messages of each. */
export const VOICE_SILENCED_PARTS_PER_TASK = 64

interface ActiveSpeech {
  speechId: string
  source: VoiceSpeechRequest['source']
  taskId?: string
  /** Set while the answer is still being written. */
  streaming?: {
    /**
     * How many sentences of each message have been handed to the worker.
     *
     * One turn can hold several messages: an agent may say something, use a
     * tool, and say something else. Each is a transcript part of its own and
     * each is read, so progress is kept per part rather than for "the newest"
     * one — which is how the first message came to be skipped.
     */
    spoken: Map<string, number>
    /** Characters already dispatched, against the reading limit. */
    charsSent: number
    /** True once the limit was reached and the rest is left unread. */
    truncated: boolean
    /** False until the first sentence of the whole passage has been sent. */
    started: boolean
  }
}

export class VoiceSpeechService {
  private readonly models: VoiceTtsModelManager
  private readonly worker: VoiceTtsWorkerClient
  private readonly listVoices: typeof listSystemVoices

  private status: VoiceTtsStatus = { state: 'loading' }
  private systemVoices: VoiceTtsVoice[] = []
  private active: ActiveSpeech | null = null
  private expectations = new Map<string, AnswerExpectation>()
  /**
   * Messages the user talked over, by task.
   *
   * Barge-in stops the passage, but the agent is still writing that same
   * message and the interrupting sentence has just been sent, which registers
   * a fresh expectation. Without this the next transcript change opened a new
   * passage against that expectation and read the interrupted message again
   * from its first word — which is 20x refusing to stop.
   *
   * A transcript part id is never reused, so a silenced message stays silenced
   * and a genuinely new message is unaffected.
   */
  private silenced = new Map<string, Set<string>>()
  /** Set when a spoken sentence was sent but the task was not named. */
  private anyExpectation: { voiceTurnId: string; expiresAt: number } | null = null
  /** Sample rate of the loaded engine, learned when it reports ready. */
  private sampleRate = 0
  private onSpeakingChange: ((speaking: boolean) => void) | null = null

  constructor(private options: VoiceSpeechServiceOptions & { modelRootDir: string }) {
    this.models =
      options.models ??
      new VoiceTtsModelManager({
        rootDir: options.modelRootDir,
        // A voice is 26 MB or 103 MB. Without this the download bar would sit
        // at nothing until the whole archive had arrived.
        onProgress: (model) =>
          options.notifyRenderer(VOICE_TTS_EVENTS.ttsModelProgress, { model }),
      })
    this.worker = options.worker ?? new VoiceTtsWorkerClient()
    this.listVoices = options.listVoices ?? listSystemVoices

    this.worker.on('status', (status: VoiceTtsStatus) => this.onWorkerStatus(status))
    this.worker.on('chunk', (chunk: VoiceTtsChunk) => this.onChunk(chunk))
    this.worker.on('done', (speechId: string, cancelled: boolean) => this.onDone(speechId, cancelled))
    this.worker.on('error', (message: string, speechId?: string) => this.onError(message, speechId))
  }

  /** Lets the session manager mirror `speaking` in its own state machine. */
  setSpeakingListener(listener: ((speaking: boolean) => void) | null): void {
    this.onSpeakingChange = listener
  }

  /** The local engine shares the runtime speech recognition installs. */
  setRuntimeModulePath(modulePath: string | null): void {
    this.worker.setRuntimeModulePath(modulePath)
  }

  shutdown(): void {
    this.worker.stop()
  }

  // ── Settings ──────────────────────────────────────────────

  isEnabled(): boolean {
    return this.options.db.getSetting(VOICE_TTS_SETTING_KEYS.enabled) === 'true'
  }

  engine(): VoiceTtsEngineId {
    const raw = this.options.db.getSetting(VOICE_TTS_SETTING_KEYS.engine)
    return isVoiceTtsEngineId(raw) ? raw : 'system'
  }

  modelId(): string {
    return this.options.db.getSetting(VOICE_TTS_SETTING_KEYS.modelId) || DEFAULT_VOICE_TTS_MODEL_ID
  }

  speed(): number {
    return clampSpeechSpeed(Number(this.options.db.getSetting(VOICE_TTS_SETTING_KEYS.speed)))
  }

  maxChars(): number {
    const raw = Number(this.options.db.getSetting(VOICE_TTS_SETTING_KEYS.maxChars))
    if (!Number.isFinite(raw) || raw <= 0) return VOICE_TTS_DEFAULT_MAX_CHARS
    return Math.min(VOICE_TTS_HARD_MAX_CHARS, Math.round(raw))
  }

  speakActionResults(): boolean {
    // On by default: a short "Task created." is the confirmation that makes a
    // hands-free command usable at all.
    return this.options.db.getSetting(VOICE_TTS_SETTING_KEYS.speakActionResults) !== 'false'
  }

  onlyVoiceTurns(): boolean {
    return this.options.db.getSetting(VOICE_TTS_SETTING_KEYS.onlyVoiceTurns) !== 'false'
  }

  /** The selected speaker, or the best default for the selected engine. */
  voiceId(): string {
    const stored = this.options.db.getSetting(VOICE_TTS_SETTING_KEYS.voiceId) || ''
    const engine = this.engine()
    if (stored && stored.startsWith(engine === 'system' ? 'system:' : 'local:')) return stored
    return this.defaultVoiceId()
  }

  private defaultVoiceId(): string {
    if (this.engine() === 'system') {
      return pickDefaultSystemVoice(this.systemVoices)?.id ?? ''
    }
    const modelId = this.modelId()
    const speaker = DEFAULT_TTS_SPEAKER_BY_MODEL[modelId] ?? 0
    return `local:${modelId}:${speaker}`
  }

  async setEnabled(enabled: boolean): Promise<VoiceTtsSnapshot> {
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.enabled, enabled ? 'true' : 'false')
    if (!enabled) this.stop('cancelled')
    else await this.prepare()
    return this.broadcast()
  }

  async setEngine(engine: VoiceTtsEngineId): Promise<VoiceTtsSnapshot> {
    this.stop('cancelled')
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.engine, engine)
    // The stored speaker belongs to the old engine, so it is cleared rather
    // than left to point at a voice that no longer exists.
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.voiceId, '')
    this.worker.unload()
    await this.prepare()
    return this.broadcast()
  }

  async setVoice(voiceId: string): Promise<VoiceTtsSnapshot> {
    this.stop('cancelled')
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.voiceId, voiceId)
    // A system voice is chosen when the engine is loaded, so the worker has to
    // hear about it. A model speaker is chosen per passage and needs nothing.
    if (this.engine() === 'system') await this.prepare()
    return this.broadcast()
  }

  async setSpeed(speed: number): Promise<VoiceTtsSnapshot> {
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.speed, String(clampSpeechSpeed(speed)))
    return this.broadcast()
  }

  async setMaxChars(maxChars: number): Promise<VoiceTtsSnapshot> {
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.maxChars, String(Math.round(maxChars)))
    return this.broadcast()
  }

  async setSpeakActionResults(on: boolean): Promise<VoiceTtsSnapshot> {
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.speakActionResults, on ? 'true' : 'false')
    return this.broadcast()
  }

  async setOnlyVoiceTurns(on: boolean): Promise<VoiceTtsSnapshot> {
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.onlyVoiceTurns, on ? 'true' : 'false')
    return this.broadcast()
  }

  // ── Models ────────────────────────────────────────────────

  listModels(): ReturnType<VoiceTtsModelManager['list']> {
    return this.models.list(this.modelId())
  }

  async installModel(id: string): Promise<VoiceTtsSnapshot> {
    await this.models.install(id)
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.modelId, id)
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.engine, 'local')
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.voiceId, '')
    this.worker.unload()
    await this.prepare()
    return this.broadcast()
  }

  async selectModel(id: string): Promise<VoiceTtsSnapshot> {
    this.stop('cancelled')
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.modelId, id)
    // Choosing a downloaded voice is choosing the engine that plays it.
    // Without this, "Use" would change nothing while the system voice is
    // selected, and the engine picker is not on the main settings view.
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.engine, 'local')
    this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.voiceId, '')
    this.worker.unload()
    await this.prepare()
    return this.broadcast()
  }

  async removeModel(id: string): Promise<VoiceTtsSnapshot> {
    this.stop('cancelled')
    await this.models.remove(id)
    if (this.modelId() === id) {
      this.worker.unload()
      // Fall back to the system voice, which needs nothing on disk, so spoken
      // answers keep working after the model is deleted.
      this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.engine, 'system')
      this.options.db.setSetting(VOICE_TTS_SETTING_KEYS.voiceId, '')
    }
    await this.prepare()
    return this.broadcast()
  }

  // ── Preparing the engine ──────────────────────────────────

  /** Loads the selected engine. Never throws: speech must not block the app. */
  async prepare(): Promise<void> {
    try {
      if (this.systemVoices.length === 0) this.systemVoices = await this.listVoices()

      if (this.engine() === 'system') {
        const name = systemVoiceName(this.voiceId())
        if (this.systemVoices.length === 0) {
          this.status = {
            state: 'unavailable',
            message: 'This system has no voice that 20x can use.',
          }
          return
        }
        this.worker.load({ engine: 'system', systemVoice: name })
        return
      }

      const model = await this.models.resolve(this.modelId())
      if (!model) {
        const entry = findTtsManifestEntry(this.modelId())
        this.status = {
          state: 'model_missing',
          message: `Download “${entry?.label ?? this.modelId()}” to use this voice.`,
        }
        return
      }
      this.worker.load({ engine: 'local', model })
    } catch (err) {
      this.status = { state: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── Correlation (design §5.7) ─────────────────────────────

  /**
   * Records that the answer to this task was asked for by voice.
   *
   * The expectation is consumed by the first answer that arrives, so a second
   * background answer for the same task is not spoken.
   */
  expectAnswer(taskId: string, voiceTurnId: string, now = Date.now()): void {
    this.expectations.set(taskId, {
      taskId,
      voiceTurnId,
      expiresAt: now + VOICE_ANSWER_EXPECTATION_MS,
    })
  }

  /**
   * DEPRECATED — no caller arms this any more, and none should.
   *
   * It matched the first answer from ANY task, so speaking to the Mastermind
   * drawer made 20x read out whatever the open task wrote next. Speech in and
   * speech out are tied to one session: the drawer names the Mastermind
   * session, a task names itself. Kept only so an older renderer cannot crash
   * main by calling it.
   *
   * The user spoke a sentence and it was sent, but the sender did not name a
   * task — the Mastermind drawer sends on its own behalf.
   *
   * The next answer to arrive is then the answer to that sentence. It is
   * consumed once and it expires quickly, so a background task finishing later
   * is still not read out.
   */
  expectAnyAnswer(voiceTurnId: string, now = Date.now()): void {
    this.anyExpectation = { voiceTurnId, expiresAt: now + VOICE_ANY_ANSWER_EXPECTATION_MS }
  }

  /** Drops an expectation, for example when the user cancels the turn. */
  forgetAnswer(taskId: string): void {
    this.expectations.delete(taskId)
  }

  /**
   * Drops the expectation that names no task.
   *
   * It matches any task at all, so anything that shows the user is no longer
   * waiting for a spoken answer has to clear it.
   */
  forgetAnyAnswer(): void {
    this.anyExpectation = null
  }

  private takeExpectation(taskId: string, now = Date.now()): AnswerExpectation | null {
    const expectation = this.expectations.get(taskId)
    if (expectation) {
      this.expectations.delete(taskId)
      return expectation.expiresAt < now ? null : expectation
    }

    // No expectation for this task by name. One may still be outstanding for a
    // sentence whose sender could not be named.
    const any = this.anyExpectation
    if (!any) return null
    this.anyExpectation = null
    if (any.expiresAt < now) return null
    return { taskId, voiceTurnId: any.voiceTurnId, expiresAt: any.expiresAt }
  }

  // ── Speaking ──────────────────────────────────────────────

  /**
   * One finished agent answer.
   *
   * Called from the `working -> idle` edge in main. It speaks only when the
   * user asked for the answer by voice, unless the user switched that rule off.
   */
  async speakAgentAnswer(taskId: string, text: string): Promise<boolean> {
    const expectation = this.takeExpectation(taskId)
    if (!expectation && this.onlyVoiceTurns()) return false
    return this.speak({
      text,
      source: 'agent_answer',
      taskId,
      ...(expectation ? { voiceTurnId: expectation.voiceTurnId } : {}),
    })
  }

  /**
   * Speaks one passage. Returns false when the passage was not spoken, which
   * is a normal outcome and never an error.
   */
  async speak(request: VoiceSpeechRequest): Promise<boolean> {
    if (!this.mayspeak(request)) return false

    const limit = request.source === 'preview' ? 300 : this.maxChars()
    const prepared = toSpokenText(request.text, limit)
    if (!prepared.text) return false

    if (this.status.state !== 'ready') await this.prepare()
    if (this.status.state !== 'ready') {
      // Nothing is spoken and nothing is broken. The settings page already says
      // what is missing.
      return false
    }

    // A new passage always replaces the old one. Two voices at once is worse
    // than losing the first passage.
    this.stop('cancelled')

    const speechId = createId()
    // The opening is shortened so the first sound arrives sooner. Everything
    // after it is produced while the previous sentence is still being heard.
    const sentences = withShortLeadIn(splitIntoSentences(prepared.text))
    const voice = this.resolveVoice(request.voiceId)
    this.active = { speechId, source: request.source, ...(request.taskId ? { taskId: request.taskId } : {}) }
    this.onSpeakingChange?.(true)

    this.options.notifyRenderer(VOICE_TTS_EVENTS.speechStart, {
      speechId,
      source: request.source,
      text: prepared.text,
      sampleRate: this.sampleRate,
      truncated: prepared.truncated,
      ...(request.taskId ? { taskId: request.taskId } : {}),
    } satisfies VoiceSpeechStartEvent)

    this.worker.speak({
      speechId,
      sentences,
      speakerId: voice.speakerId,
      speed: this.speed(),
      ...(voice.engine === 'system' ? { systemVoice: systemVoiceName(voice.id) } : {}),
    })
    return true
  }

  // ── Reading an answer as it is written (design §5.7) ──────

  /**
   * The agent has begun an answer to something the user asked by voice.
   *
   * The passage opens empty and is filled as the words arrive, so speech starts
   * with the first finished sentence instead of after the last one. Waiting for
   * the agent to stop would put the whole spoken answer behind the agent — on a
   * long answer, minutes behind.
   *
   * Returns false when this answer may not be spoken, and then the caller need
   * not push anything.
   */
  async beginStreamingAnswer(taskId: string, parts?: VoiceAnswerPart[]): Promise<boolean> {
    if (this.active?.streaming && this.active.taskId === taskId) return true

    // An answer the user talked over must not open a passage. Opening one
    // consumes the expectation left by the sentence that interrupted it, and
    // then the interrupted answer is read again from its first word.
    if (parts && this.audibleParts(taskId, parts).length === 0) return false

    const expectation = this.takeExpectation(taskId)
    if (!expectation && this.onlyVoiceTurns()) return false
    if (!this.isEnabled()) return false

    if (this.status.state !== 'ready') await this.prepare()
    if (this.status.state !== 'ready') return false

    this.stop('cancelled')
    const speechId = createId()
    const voice = this.resolveVoice()
    this.active = {
      speechId,
      source: 'agent_answer',
      taskId,
      streaming: { spoken: new Map(), charsSent: 0, truncated: false, started: false },
    }
    this.onSpeakingChange?.(true)

    this.options.notifyRenderer(VOICE_TTS_EVENTS.speechStart, {
      speechId,
      source: 'agent_answer',
      text: '',
      taskId,
      sampleRate: this.sampleRate,
      truncated: false,
    } satisfies VoiceSpeechStartEvent)

    this.worker.speak({
      speechId,
      sentences: [],
      open: true,
      speakerId: voice.speakerId,
      speed: this.speed(),
      ...(voice.engine === 'system' ? { systemVoice: systemVoiceName(voice.id) } : {}),
    })
    return true
  }

  /**
   * The answer so far. Only sentences that are certainly finished are read;
   * the tail waits for the next words.
   *
   * `partId` names the piece of the transcript this text belongs to. An agent
   * may write an answer in several pieces, and each one starts from nothing.
   */
  pushStreamingAnswer(taskId: string, allParts: VoiceAnswerPart[], final = false): void {
    const active = this.active
    const streaming = active?.streaming
    if (!active || !streaming || active.taskId !== taskId) return

    // A message the user talked over is dropped before anything else, so the
    // rest of it is never read and it cannot hold up the messages after it.
    const parts = this.audibleParts(taskId, allParts)

    for (let i = 0; i < parts.length; i++) {
      if (streaming.truncated) return
      const part = parts[i]
      // Only the last message of the turn can still be growing. Every earlier
      // one is finished, so its closing sentence is released rather than held.
      const complete = final || i < parts.length - 1
      this.pushOnePart(active.speechId, taskId, part, complete)
    }
  }

  /** One message of the answer. Says whatever of it is new and finished. */
  private pushOnePart(
    speechId: string,
    taskId: string,
    part: VoiceAnswerPart,
    complete: boolean
  ): void {
    const streaming = this.active?.streaming
    if (!streaming) return

    const already = streaming.spoken.get(part.partId) ?? 0
    const prepared = toSpokenText(part.content, this.maxChars())
    const { sentences } = splitStreamingSentences(prepared.text, complete)
    let fresh = sentences.slice(already)
    if (fresh.length === 0) return

    // Nothing has been said yet, so this is the opening of the whole answer and
    // its length is the wait before speech starts.
    const before = fresh.length
    if (!streaming.started) fresh = withShortLeadIn(fresh)
    // The split adds a piece the transcript does not have, so the counter is
    // corrected by exactly what was added rather than by a guess.
    const leadInExtra = fresh.length - before

    // The reading limit applies to the whole answer, not to one message of it.
    const allowed: string[] = []
    for (const sentence of fresh) {
      if (streaming.charsSent + sentence.length > this.maxChars()) {
        streaming.truncated = true
        break
      }
      streaming.charsSent += sentence.length + 1
      allowed.push(sentence)
    }
    if (allowed.length === 0) return

    streaming.started = true
    // The counter follows the transcript, not what was said aloud.
    streaming.spoken.set(part.partId, already + Math.max(0, allowed.length - leadInExtra))
    this.options.notifyRenderer(VOICE_TTS_EVENTS.speechStart, {
      speechId,
      source: 'agent_answer',
      text: prepared.text,
      taskId,
      sampleRate: this.sampleRate,
      truncated: streaming.truncated,
    } satisfies VoiceSpeechStartEvent)
    this.worker.append(speechId, allowed)
  }

  /** No more of this answer is coming. What is queued is still read. */
  endStreamingAnswer(taskId: string): void {
    const active = this.active
    if (!active?.streaming || active.taskId !== taskId) return
    this.worker.finish(active.speechId)
  }

  /** True while an answer is being read as it is written. */
  get streamingTaskId(): string | null {
    return this.active?.streaming ? (this.active.taskId ?? null) : null
  }

  /**
   * The user talked over the answer, or pressed stop. This is barge-in.
   *
   * It differs from `stop` in one way that matters: the message being read is
   * remembered as silenced, so the rest of it is never read out. `stop` alone
   * ends the passage, and the agent's next few words open a new one.
   */
  interrupt(): void {
    const active = this.active
    if (active?.streaming && active.taskId) {
      this.silence(active.taskId, active.streaming.spoken.keys())
    }
    this.stop('cancelled')
  }

  /** Marks messages of a task as never to be read again. */
  private silence(taskId: string, partIds: Iterable<string>): void {
    let set = this.silenced.get(taskId)
    if (!set) {
      set = new Set()
      // Bounded: this map outlives every passage, so it must not grow for ever
      // in a session that runs for days.
      if (this.silenced.size >= VOICE_SILENCED_TASKS) {
        const oldest = this.silenced.keys().next()
        if (!oldest.done) this.silenced.delete(oldest.value)
      }
      this.silenced.set(taskId, set)
    }
    for (const partId of partIds) set.add(partId)
    while (set.size > VOICE_SILENCED_PARTS_PER_TASK) {
      const oldest = set.keys().next()
      if (oldest.done) break
      set.delete(oldest.value)
    }
  }

  /**
   * The messages of an answer that may still be read: everything except what
   * the user has already talked over.
   */
  audibleParts(taskId: string, parts: VoiceAnswerPart[]): VoiceAnswerPart[] {
    const silenced = this.silenced.get(taskId)
    if (!silenced || silenced.size === 0) return parts
    return parts.filter((part) => !silenced.has(part.partId))
  }

  /** Stops the current passage at once, without silencing anything. */
  stop(reason: VoiceSpeechEndEvent['reason'] = 'cancelled'): void {
    const active = this.active
    if (!active) return
    this.active = null
    this.worker.cancel(active.speechId)
    this.onSpeakingChange?.(false)
    this.options.notifyRenderer(VOICE_TTS_EVENTS.speechEnd, {
      speechId: active.speechId,
      reason,
    } satisfies VoiceSpeechEndEvent)
  }

  get speaking(): boolean {
    return this.active !== null
  }

  /**
   * The policy. Only these five reasons can produce speech, and each one has
   * its own condition (design §5.7).
   */
  private mayspeak(request: VoiceSpeechRequest): boolean {
    if (!request.text || !request.text.trim()) return false
    switch (request.source) {
      // The user pressed a button. Speaking is the whole point of the press, so
      // it does not also need the automatic switch to be on.
      case 'preview':
      case 'manual':
      case 'read_last_answer':
        return true
      case 'agent_answer':
        if (!this.isEnabled()) return false
        return !this.onlyVoiceTurns() || Boolean(request.voiceTurnId)
      case 'action_result':
        return this.isEnabled() && this.speakActionResults()
      default:
        return false
    }
  }

  /** Turns a voice ID into the engine, model and speaker index to use. */
  private resolveVoice(override?: string): VoiceTtsVoice {
    const id = override || this.voiceId()
    const voices = this.availableVoices()
    const found = voices.find((voice) => voice.id === id)
    if (found) return found
    return (
      voices[0] ?? {
        id,
        label: id,
        engine: this.engine(),
        speakerId: 0,
        modelId: this.modelId(),
        language: 'en',
        description: '',
      }
    )
  }

  /** Every speaker the user can choose right now. */
  availableVoices(): VoiceTtsVoice[] {
    if (this.engine() === 'system') return this.systemVoices
    return localVoicesForModel(this.modelId())
  }

  // ── Worker events ─────────────────────────────────────────

  private onWorkerStatus(status: VoiceTtsStatus): void {
    if (status.state === 'ready') {
      this.sampleRate = status.sampleRate
      this.status = { ...status, engine: this.engine(), voiceId: this.voiceId() }
    } else {
      this.status = status
      if (status.state !== 'loading') this.stop('error')
    }
    void this.broadcast()
  }

  private onChunk(chunk: VoiceTtsChunk): void {
    if (!this.active || this.active.speechId !== chunk.speechId) return
    if (chunk.sampleRate > 0) this.sampleRate = chunk.sampleRate
    this.options.notifyRenderer(VOICE_TTS_EVENTS.speechChunk, {
      speechId: chunk.speechId,
      index: chunk.index,
      // A plain byte array crosses the Electron bridge as a structured clone.
      pcm: new Uint8Array(chunk.pcm),
      sampleRate: chunk.sampleRate,
      text: chunk.text,
    })
  }

  private onDone(speechId: string, cancelled: boolean): void {
    if (!this.active || this.active.speechId !== speechId) return
    this.active = null
    this.onSpeakingChange?.(false)
    this.options.notifyRenderer(VOICE_TTS_EVENTS.speechEnd, {
      speechId,
      reason: cancelled ? 'cancelled' : 'complete',
    } satisfies VoiceSpeechEndEvent)
  }

  private onError(message: string, speechId?: string): void {
    if (speechId && this.active?.speechId !== speechId) return
    const id = speechId ?? this.active?.speechId
    this.active = null
    this.onSpeakingChange?.(false)
    if (!id) return
    this.options.notifyRenderer(VOICE_TTS_EVENTS.speechEnd, {
      speechId: id,
      reason: 'error',
      message,
    } satisfies VoiceSpeechEndEvent)
  }

  // ── Snapshots ─────────────────────────────────────────────

  async snapshot(): Promise<VoiceTtsSnapshot> {
    if (this.systemVoices.length === 0 && this.engine() === 'system') {
      this.systemVoices = await this.listVoices()
    }
    return {
      enabled: this.isEnabled(),
      engine: this.engine(),
      status: this.status,
      voices: this.availableVoices(),
      voiceId: this.voiceId(),
      speed: this.speed(),
      maxChars: this.maxChars(),
      speakActionResults: this.speakActionResults(),
      onlyVoiceTurns: this.onlyVoiceTurns(),
      models: await this.listModels(),
      speaking: this.speaking,
    }
  }

  private async broadcast(): Promise<VoiceTtsSnapshot> {
    const snapshot = await this.snapshot()
    this.options.notifyRenderer(VOICE_TTS_EVENTS.ttsStatus, snapshot)
    return snapshot
  }
}

/** The speakers one catalogue model offers, as selectable voices. */
export function localVoicesForModel(modelId: string): VoiceTtsVoice[] {
  const entry = findTtsManifestEntry(modelId)
  if (!entry) return []
  return entry.speakers.map((speaker) => ({
    id: `local:${entry.id}:${speaker.speakerId}`,
    label: speaker.label,
    engine: 'local' as const,
    speakerId: speaker.speakerId,
    modelId: entry.id,
    language: entry.languages[0] ?? 'en',
    description: speaker.description,
  }))
}

/** Every speaker of every catalogue model. Used by the settings page. */
export function allLocalVoices(): VoiceTtsVoice[] {
  return VOICE_TTS_MODEL_MANIFEST.flatMap((entry) => localVoicesForModel(entry.id))
}

export { VOICE_TTS_DEFAULT_SPEED }
