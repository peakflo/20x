/**
 * Lifecycle of the isolated speech worker (design §5.1).
 *
 * The client owns the child process, the audio pipe and the restart policy.
 * Nothing here decodes audio: a crash in the worker must leave main and the
 * renderer running.
 */

import { fork, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync } from 'fs'
import type { ResolvedModel } from './voice-model-manager'
import type { VoiceEngineStatus } from '../../shared/voice'

/** Release the model after this much idle time to give the memory back. */
export const VOICE_IDLE_UNLOAD_MS = 5 * 60 * 1000

interface WorkerMessage {
  t: 'status' | 'partial' | 'final' | 'error' | 'pong'
  state?: string
  turnId?: string
  text?: string
  message?: string
  code?: string
  modelId?: string
  engine?: string
  loadMs?: number
  rss?: number
}

export interface VoiceWorkerEvents {
  status: (status: VoiceEngineStatus) => void
  partial: (turnId: string, text: string) => void
  final: (turnId: string, text: string) => void
  error: (message: string, code?: string) => void
}

export class VoiceWorkerClient extends EventEmitter {
  private child: ChildProcess | null = null
  private loadedModel: ResolvedModel | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private restarts = 0

  constructor(private scriptPath = defaultWorkerScript()) {
    super()
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed)
  }

  get isLoaded(): boolean {
    return Boolean(this.loadedModel)
  }

  /** Starts the worker if needed and loads a model. Idempotent per model. */
  async load(model: ResolvedModel): Promise<void> {
    if (!existsSync(this.scriptPath)) {
      this.emit('status', {
        state: 'engine_missing',
        message: 'The voice worker was not found in this build.',
      } satisfies VoiceEngineStatus)
      return
    }
    if (this.loadedModel && this.loadedModel.dir === model.dir && this.isRunning) return

    this.spawn()
    this.loadedModel = model
    this.emit('status', { state: 'loading' } satisfies VoiceEngineStatus)
    this.child?.send({
      t: 'load',
      modelId: model.id,
      model: {
        encoder: model.encoder,
        decoder: model.decoder,
        joiner: model.joiner,
        tokens: model.tokens,
      },
    })
  }

  startTurn(turnId: string): void {
    this.clearIdleTimer()
    this.child?.send({ t: 'start', turnId })
  }

  /** Pushes one 16 kHz mono PCM frame. Frames are length-prefixed on the pipe. */
  pushAudio(frame: Buffer): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) return
    const header = Buffer.alloc(4)
    header.writeUInt32LE(frame.length, 0)
    // Back-pressure is handled by the stream itself; a dropped write only loses
    // audio, it never blocks the main event loop.
    stdin.write(Buffer.concat([header, frame]))
  }

  endTurn(turnId: string): void {
    this.child?.send({ t: 'end', turnId })
    this.scheduleIdleUnload()
  }

  cancelTurn(turnId: string): void {
    this.child?.send({ t: 'cancel', turnId })
    this.scheduleIdleUnload()
  }

  /** Releases the model but keeps the process, so the next turn starts sooner. */
  unload(): void {
    this.child?.send({ t: 'unload' })
    this.loadedModel = null
  }

  stop(): void {
    this.clearIdleTimer()
    this.loadedModel = null
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

  private spawn(): void {
    if (this.isRunning) return
    this.child = fork(this.scriptPath, [], {
      // Electron ships its own Node. `ELECTRON_RUN_AS_NODE` runs the worker as
      // a plain Node process, which is the pattern the MCP servers already use.
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    })

    this.child.on('message', (raw) => this.onMessage(raw as WorkerMessage))
    this.child.stderr?.on('data', (data: Buffer) => {
      console.error('[voice-worker]', data.toString().trim())
    })
    this.child.on('exit', (code) => {
      const wasLoaded = this.loadedModel
      this.child = null
      this.loadedModel = null
      if (code === 0) return
      this.emit('error', `The voice worker stopped (code ${code}).`, 'worker_exit')
      // One automatic restart. A repeated crash leaves voice off rather than
      // spawning processes in a loop.
      if (wasLoaded && this.restarts < 1) {
        this.restarts += 1
        void this.load(wasLoaded)
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
            modelId: message.modelId ?? 'unknown',
            engine: message.engine ?? 'sherpa-onnx',
          } satisfies VoiceEngineStatus)
        } else if (message.state === 'engine_missing') {
          this.loadedModel = null
          this.emit('status', {
            state: 'engine_missing',
            message: message.message ?? 'The local speech runtime is not installed.',
          } satisfies VoiceEngineStatus)
        } else if (message.state === 'error') {
          this.loadedModel = null
          this.emit('status', {
            state: 'error',
            message: message.message ?? 'The speech model failed to load.',
          } satisfies VoiceEngineStatus)
        }
        return
      case 'partial':
        if (message.turnId && message.text) this.emit('partial', message.turnId, message.text)
        return
      case 'final':
        if (message.turnId) this.emit('final', message.turnId, message.text ?? '')
        return
      case 'error':
        this.emit('error', message.message ?? 'Speech recognition failed.', message.code)
        return
      default:
        return
    }
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => this.unload(), VOICE_IDLE_UNLOAD_MS)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

/** The worker is copied next to the main bundle by `electron.vite.config.ts`. */
export function defaultWorkerScript(): string {
  return join(__dirname, 'voice', 'voice-worker.js')
}
