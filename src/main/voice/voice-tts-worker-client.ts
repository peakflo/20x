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

  speak(request: VoiceTtsSpeakRequest): void {
    this.clearIdleTimer()
    this.send({ t: 'speak', ...request })
  }

  cancel(speechId?: string): void {
    this.send({ t: 'cancel', speechId })
    this.scheduleIdleUnload()
  }

  unload(): void {
    this.send({ t: 'unload' })
    this.request = null
  }

  stop(): void {
    this.clearIdleTimer()
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
          this.emit('status', {
            state: 'ready',
            engine: this.request?.engine ?? 'system',
            modelId: message.modelId ?? '',
            voiceId: '',
            sampleRate: message.sampleRate ?? 0,
          } satisfies VoiceTtsStatus)
        } else if (message.state === 'engine_missing') {
          this.request = null
          this.emit('status', {
            state: 'model_missing',
            message: message.message ?? 'No voice is available.',
          } satisfies VoiceTtsStatus)
        } else if (message.state === 'error') {
          this.request = null
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
