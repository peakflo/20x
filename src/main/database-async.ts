/**
 * Async Database Proxy
 *
 * Communicates with the database-worker thread via postMessage/onMessage.
 * All methods return Promises that resolve when the worker responds.
 *
 * This keeps the main Electron event loop free from better-sqlite3
 * synchronous calls during hot-path operations (polling, session lifecycle).
 */
import { Worker } from 'worker_threads'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  TaskRecord,
  UpdateTaskData,
  AgentRecord,
  McpServerRecord,
  SkillRecord,
  SecretRecord
} from './database'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class DatabaseAsync {
  private worker: Worker
  private pending = new Map<string, PendingRequest>()
  private ready: Promise<void>

  constructor(dbPath: string) {
    const workerPath = join(__dirname, 'database-worker.js')

    this.worker = new Worker(workerPath, {
      workerData: { dbPath }
    })

    this.worker.on('message', (msg: { id?: string; type?: string; result?: unknown; error?: string }) => {
      // Handle ready signal
      if (msg.type === 'ready') return

      // Handle response to a pending request
      if (msg.id) {
        const pending = this.pending.get(msg.id)
        if (!pending) return

        this.pending.delete(msg.id)

        if (msg.error) {
          pending.reject(new Error(msg.error))
        } else {
          pending.resolve(msg.result)
        }
      }
    })

    this.worker.on('error', (err) => {
      console.error('[DatabaseAsync] Worker error:', err)
      // Reject all pending requests
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`Worker error: ${err instanceof Error ? err.message : String(err)}`))
        this.pending.delete(id)
      }
    })

    // Wait for the worker to signal ready
    this.ready = new Promise<void>((resolve) => {
      const onMessage = (msg: { type?: string }) => {
        if (msg.type === 'ready') {
          this.worker.removeListener('message', onMessage)
          resolve()
        }
      }
      this.worker.on('message', onMessage)
    })
  }

  /** Waits for the worker to be ready */
  async waitForReady(): Promise<void> {
    return this.ready
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.worker.postMessage({ id, method, args })
    })
  }

  // ── Task methods ─────────────────────────────────────────────

  getTasks(): Promise<TaskRecord[]> {
    return this.call<TaskRecord[]>('getTasks')
  }

  getTask(id: string): Promise<TaskRecord | undefined> {
    return this.call<TaskRecord | undefined>('getTask', id)
  }

  updateTask(id: string, data: UpdateTaskData): Promise<TaskRecord | undefined> {
    return this.call<TaskRecord | undefined>('updateTask', id, data)
  }

  // ── Agent methods ────────────────────────────────────────────

  getAgents(): Promise<AgentRecord[]> {
    return this.call<AgentRecord[]>('getAgents')
  }

  getAgent(id: string): Promise<AgentRecord | undefined> {
    return this.call<AgentRecord | undefined>('getAgent', id)
  }

  // ── MCP Server methods ───────────────────────────────────────

  getMcpServers(): Promise<McpServerRecord[]> {
    return this.call<McpServerRecord[]>('getMcpServers')
  }

  getMcpServer(id: string): Promise<McpServerRecord | undefined> {
    return this.call<McpServerRecord | undefined>('getMcpServer', id)
  }

  // ── Skill methods ────────────────────────────────────────────

  getSkills(): Promise<SkillRecord[]> {
    return this.call<SkillRecord[]>('getSkills')
  }

  getSkillsByIds(ids: string[]): Promise<SkillRecord[]> {
    return this.call<SkillRecord[]>('getSkillsByIds', ids)
  }

  // ── Secret methods (metadata only — decryption stays on main thread) ──

  getSecretsByIds(ids: string[]): Promise<SecretRecord[]> {
    return this.call<SecretRecord[]>('getSecretsByIds', ids)
  }

  // ── Settings ─────────────────────────────────────────────────

  getSetting(key: string): Promise<string | undefined> {
    return this.call<string | undefined>('getSetting', key)
  }

  getAllSettings(): Promise<Record<string, string>> {
    return this.call<Record<string, string>>('getAllSettings')
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async close(): Promise<void> {
    try {
      await this.call<boolean>('close')
    } catch {
      // Worker may already be terminated
    }
    await this.worker.terminate()
  }
}
