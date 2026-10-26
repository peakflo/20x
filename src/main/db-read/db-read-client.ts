/**
 * Main-process client for the read-only DB worker (db-read-worker.ts).
 *
 * Boundary: only reads that are already async at their call site go through
 * here (IPC/HTTP handlers). The main connection remains the only writer, and
 * every method falls back to the synchronous main-connection read when the
 * worker is disabled, fails to start, crashes or reports an error, so callers
 * always get an answer.
 *
 * There is deliberately no per-request timeout: a read that is slow in the
 * worker (a huge transcript on a loaded machine) would be just as slow on the
 * main thread, and re-running it there would block the UI for that long.
 *
 * Kill switch: TWENTYX_DB_READ_WORKER=0 keeps every read on the main thread.
 */
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { TranscriptPartRecord } from './transcript-query'
import type { DbReadRequest, DbReadResponse, DbReadWorkerData } from './db-read-protocol'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type RequestBody = DistributiveOmit<DbReadRequest, 'id'>

export interface DbReadFallback {
  getTranscriptParts(taskId: string, sinceSeq?: number): TranscriptPartRecord[]
}

export interface DbReadClientOptions {
  dbPath: string
  fallback: DbReadFallback
  /** Worker script; defaults to the bundled `db-read-worker.js` next to the main bundle. */
  scriptPath?: string
  createWorker?: (scriptPath: string, data: DbReadWorkerData) => Worker
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export function isDbReadWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TWENTYX_DB_READ_WORKER !== '0'
}

export function dbReadWorkerScriptPath(directory = __dirname): string {
  return join(directory, 'db-read-worker.js')
}

export class DbReadClient {
  private worker: Worker | null = null
  private disabled = false
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly options: DbReadClientOptions) {}

  /** Starts the worker now so the first read does not pay its boot time. */
  start(): void {
    this.ensureWorker()
  }

  /** True while reads are served by the worker. */
  get active(): boolean {
    return !this.disabled && this.worker !== null
  }

  getTranscriptParts(taskId: string, sinceSeq?: number): Promise<TranscriptPartRecord[]> {
    return this.request<TranscriptPartRecord[]>(
      { op: 'getTranscriptParts', taskId, ...(sinceSeq != null ? { sinceSeq } : {}) },
      () => this.options.fallback.getTranscriptParts(taskId, sinceSeq)
    )
  }

  async close(): Promise<void> {
    this.disabled = true
    const worker = this.worker
    this.worker = null
    this.failPending(new Error('db-read worker closed'))
    if (worker) await worker.terminate()
  }

  private async request<T>(body: RequestBody, fallback: () => T): Promise<T> {
    const worker = this.ensureWorker()
    if (!worker) return fallback()
    const id = this.nextId++
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        worker.postMessage({ ...body, id } as DbReadRequest)
      })
    } catch (err) {
      console.warn(`[DbReadClient] ${body.op} fell back to the main connection:`, err instanceof Error ? err.message : err)
      return fallback()
    }
  }

  private ensureWorker(): Worker | null {
    if (this.disabled) return null
    if (this.worker) return this.worker
    const scriptPath = this.options.scriptPath ?? dbReadWorkerScriptPath()
    const data: DbReadWorkerData = { dbPath: this.options.dbPath }
    try {
      const worker = this.options.createWorker
        ? this.options.createWorker(scriptPath, data)
        : new Worker(scriptPath, { workerData: data, name: '20x db-read' })
      worker.unref()
      worker.on('message', (message: DbReadResponse) => this.onMessage(message))
      worker.on('error', (err: Error) => this.onWorkerGone(err))
      worker.on('exit', (code) => this.onWorkerGone(new Error(`db-read worker exited with code ${code}`)))
      this.worker = worker
      return worker
    } catch (err) {
      this.onWorkerGone(err instanceof Error ? err : new Error(String(err)))
      return null
    }
  }

  private onMessage(message: DbReadResponse): void {
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error))
  }

  /** A crashed or unloadable worker is not restarted: reads stay on the main connection. */
  private onWorkerGone(err: Error): void {
    if (this.disabled) return
    this.disabled = true
    this.worker = null
    console.warn('[DbReadClient] worker unavailable, reads stay on the main thread:', err.message)
    this.failPending(err)
  }

  private failPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      entry.reject(err)
      this.pending.delete(id)
    }
  }
}
