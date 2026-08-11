/**
 * Lifecycle of the isolated speech-synthesis worker (design §5.1).
 *
 * The client owns the child process and the restart policy. Nothing here
 * produces audio: a crash in the worker must leave main and the renderer
 * running, and voice must simply go quiet.
 */

import { fork, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync } from 'fs'
import type { VoiceTtsEngineId, VoiceTtsStatus } from '../../shared/voice-tts'
import type { ResolvedTtsModel } from './voice-tts-model-manager'

/** Release the model after this much quiet to give the memory back. */
export const VOICE_TTS_IDLE_UNLOAD_MS = 5 * 60 * 1000

/** How long a held passage waits for a voice to come back before giving up. */
export const VOICE_TTS_RELOAD_TIMEOUT_MS = 60 * 1000

export interface VoiceTtsLoadRequest {
  engine: VoiceTtsEngineId
  /** Required for the local engine, absent for the system voice. */
  model?: ResolvedTtsModel
  /** Operating-system voice name for the system engine. */
  systemVoice?: string
}

export interface VoiceTtsSpeakRequest {
  speechId: string
  sentences: string[]
  speakerId: number
  speed: number
  systemVoice?: string
  /**
   * Leaves the passage open, so sentences can be added while it is read.
   *
   * An agent answer arrives a few words at a time. Waiting for the last word
   * before saying the first would put the whole spoken answer behind the agent.
   */
  open?: boolean
}

interface WorkerMessage {
  t: 'status' | 'chunk' | 'done' | 'error' | 'pong'
  state?: string
  engine?: string
  modelId?: string
  sampleRate?: number
  numSpeakers?: number
  message?: string
  code?: string
  speechId?: string
  index?: number
  text?: string
  pcm?: string
  chunks?: number
  elapsedMs?: number
  cancelled?: boolean
}

export interface VoiceTtsChunk {
  speechId: string
  index: number
  pcm: Buffer
  sampleRate: number
  text: string
}

export class VoiceTtsWorkerClient extends EventEmitter {
  private child: ChildProcess | null = null
  private request: VoiceTtsLoadRequest | null = null
  /**
   * The last voice asked for, kept across an unload.
   *
   * `request` means "loaded right now" and is cleared when the worker gives
   * the memory back. Without a second copy there is nothing to load again, and
   * the next passage fails with "No voice is loaded" until something else
   * happens to call `load`.
   */
  private lastRequest: VoiceTtsLoadRequest | null = null
  /** A passage waiting for the voice it needs. At most one: a new one replaces it. */
  private pendingSpeak: VoiceTtsSpeakRequest | null = null
  /**
   * Sentences added to that passage while it waits.
   *
   * A streaming answer opens its passage empty and fills it as the words
   * arrive. If the voice happens to be reloading, those sentences would reach a
   * worker that has no passage open and be dropped — the answer would simply be
   * silent — so they wait here with it.
   */
  private pendingAppends: string[] = []
  private pendingFinish = false
  private reloadTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private restarts = 0
  private modulePath: string | null = null

  constructor(private scriptPath = defaultTtsWorkerScript()) {
    super()
  }

  /** Points the worker at the runtime speech recognition installed on request. */
  setRuntimeModulePath(modulePath: string | null): void {
    if (this.modulePath === modulePath) return
    this.modulePath = modulePath
    // Only the local engine uses the runtime. Restarting for the system voice
    // would stop speech for no reason.
    if (this.request?.engine === 'local') this.stop()
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed)
  }

  get isLoaded(): boolean {
    return this.request !== null && this.isRunning
  }

  /** Starts the worker if needed and loads one engine. Idempotent per engine. */
  load(request: VoiceTtsLoadRequest): void {
    if (!existsSync(this.scriptPath)) {
      this.emit('status', {
        state: 'error',
        message: 'The speech worker was not found in this build.',
      } satisfies VoiceTtsStatus)
      return
    }
    if (this.isLoaded && sameRequest(this.request, request)) return

    this.spawn()
    this.request = request
    this.lastRequest = request
    this.emit('status', { state: 'loading' } satisfies VoiceTtsStatus)
    this.send({
      t: 'load',
      engine: request.engine,
      modelId: request.model?.id ?? '',
      systemVoice: request.systemVoice ?? '',
      ...(request.model
        ? {
            model: {
              family: request.model.family,
              model: request.model.model,
              voices: request.model.voices,
              tokens: request.model.tokens,
              dataDir: request.model.dataDir,
              sampleRate: request.model.sampleRate,
            },
          }
        : {}),
    })
  }

  /**
   * Speaks a passage, loading the voice again first if it was released.
   *
   * The worker gives the memory back after five minutes of quiet, so the
   * common case — read something, wait, read something else — arrived with no
   * voice loaded and was refused. Loading is asynchronous, so the passage is
   * held until the worker reports `ready` rather than sent straight after the
   * load and lost.
   */
  speak(request: VoiceTtsSpeakRequest): void {
    this.clearIdleTimer()

    if (this.isLoaded) {
      this.send({ t: 'speak', ...request })
      return
    }

    if (!this.lastRequest) {
      this.emit('error', 'No voice is loaded.', request.speechId)
      return
    }

    this.pendingSpeak = request
    this.pendingAppends = []
    this.pendingFinish = false
    this.armReloadTimeout()
    this.load(this.lastRequest)
  }

  /** Adds sentences to a passage that was opened with `open`. */
  append(speechId: string, sentences: string[]): void {
    if (sentences.length === 0) return
    this.clearIdleTimer()
    if (this.pendingSpeak?.speechId === speechId) {
      this.pendingAppends.push(...sentences)
      return
    }
    this.send({ t: 'append', speechId, sentences })
  }

  /** Closes an open passage. It ends once the queued sentences are read. */
  finish(speechId: string): void {
    if (this.pendingSpeak?.speechId === speechId) {
      this.pendingFinish = true
      return
    }
    this.send({ t: 'finish', speechId })
  }

  cancel(speechId?: string): void {
    this.send({ t: 'cancel', speechId })
    this.scheduleIdleUnload()
  }

  unload(): void {
    this.send({ t: 'unload' })
    // `lastRequest` survives on purpose: the next passage loads it again.
    this.request = null
  }

  stop(): void {
    this.clearIdleTimer()
    this.clearReloadTimeout()
    this.pendingSpeak = null
    this.pendingAppends = []
    this.pendingFinish = false
    this.request = null
    const child = this.child
    this.child = null
    if (!child) return
    child.removeAllListeners()
    try {
      child.kill()
    } catch {
      /* the process is already gone */
    }
  }

  // ── Internals ─────────────────────────────────────────────

  private send(message: Record<string, unknown>): void {
    const child = this.child
    if (!child || !child.connected) return
    try {
      child.send(message, undefined, undefined, () => {})
    } catch {
      /* the worker went away */
    }
  }

  private spawn(): void {
    if (this.isRunning) return
    this.child = fork(this.scriptPath, [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(this.modulePath ? { VOICE_ENGINE_MODULE: this.modulePath } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    })

    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream?.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return
        console.error('[voice-tts-worker] pipe error:', err.message)
      })
    }
    this.child.on('error', (err) => {
      console.error('[voice-tts-worker] process error:', err.message)
      this.emit('error', 'The speech worker could not be started.')
    })
    this.child.stderr?.on('data', (data: Buffer) => {
      console.error('[voice-tts-worker]', data.toString().trim())
    })
    this.child.on('message', (raw) => this.onMessage(raw as WorkerMessage))
    this.child.on('exit', (code) => {
      const wasLoaded = this.request
      this.child = null
      this.request = null
      if (code === 0) return
      this.emit('error', `The speech worker stopped (code ${code}).`)
      // One automatic restart. A repeated crash leaves speech off rather than
      // spawning processes in a loop.
      if (wasLoaded && this.restarts < 1) {
        this.restarts += 1
        this.load(wasLoaded)
      }
    })
  }

  private onMessage(message: WorkerMessage): void {
    switch (message.t) {
      case 'status':
        if (message.state === 'ready') {
          this.restarts = 0
          this.flushPendingSpeak()
          this.emit('status', {
            state: 'ready',
            engine: this.request?.engine ?? 'system',
            modelId: message.modelId ?? '',
            voiceId: '',
            sampleRate: message.sampleRate ?? 0,
          } satisfies VoiceTtsStatus)
        } else if (message.state === 'engine_missing') {
          this.request = null
          this.failPendingSpeak(message.message ?? 'No voice is available.')
          this.emit('status', {
            state: 'model_missing',
            message: message.message ?? 'No voice is available.',
          } satisfies VoiceTtsStatus)
        } else if (message.state === 'error') {
          this.request = null
          this.failPendingSpeak(message.message ?? 'The voice failed to load.')
          this.emit('status', {
            state: 'error',
            message: message.message ?? 'The voice failed to load.',
          } satisfies VoiceTtsStatus)
        }
        return
      case 'chunk':
        if (!message.speechId || !message.pcm) return
        this.emit('chunk', {
          speechId: message.speechId,
          index: message.index ?? 0,
          pcm: Buffer.from(message.pcm, 'base64'),
          sampleRate: message.sampleRate ?? 0,
          text: message.text ?? '',
        } satisfies VoiceTtsChunk)
        return
      case 'done':
        if (!message.speechId) return
        this.scheduleIdleUnload()
        this.emit('done', message.speechId, Boolean(message.cancelled), message.chunks ?? 0)
        return
      case 'error':
        this.emit('error', message.message ?? 'Speech synthesis failed.', message.speechId)
        return
      default:
        return
    }
  }

  /** Sends the held passage, and everything that arrived while it waited. */
  private flushPendingSpeak(): void {
    const pending = this.pendingSpeak
    if (!pending) return
    const appends = this.pendingAppends
    const finish = this.pendingFinish
    this.pendingSpeak = null
    this.pendingAppends = []
    this.pendingFinish = false
    this.clearReloadTimeout()

    this.send({ t: 'speak', ...pending })
    if (appends.length > 0) this.send({ t: 'append', speechId: pending.speechId, sentences: appends })
    if (finish) this.send({ t: 'finish', speechId: pending.speechId })
  }

  /**
   * Gives up on a held passage.
   *
   * Silence with no explanation is the worst outcome: the caller is waiting
   * for a `done` that will never arrive, so the error carries the speech ID.
   */
  private failPendingSpeak(reason: string): void {
    const pending = this.pendingSpeak
    if (!pending) return
    this.pendingSpeak = null
    this.pendingAppends = []
    this.pendingFinish = false
    this.clearReloadTimeout()
    this.emit('error', reason, pending.speechId)
  }

  private armReloadTimeout(): void {
    this.clearReloadTimeout()
    this.reloadTimer = setTimeout(
      () => this.failPendingSpeak('The voice did not load in time.'),
      VOICE_TTS_RELOAD_TIMEOUT_MS
    )
    this.reloadTimer.unref?.()
  }

  private clearReloadTimeout(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = null
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => this.unload(), VOICE_TTS_IDLE_UNLOAD_MS)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

function sameRequest(a: VoiceTtsLoadRequest | null, b: VoiceTtsLoadRequest): boolean {
  if (!a) return false
  if (a.engine !== b.engine) return false
  if (a.engine === 'system') return (a.systemVoice ?? '') === (b.systemVoice ?? '')
  return a.model?.dir === b.model?.dir
}

/** The worker is copied next to the main bundle by `electron.vite.config.ts`. */
export function defaultTtsWorkerScript(): string {
  return join(__dirname, 'voice', 'voice-tts-worker.js')
}
