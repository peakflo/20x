import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { builtinModules } from 'node:module'
import { Worker } from 'node:worker_threads'
import { build } from 'vite'
import { app } from 'electron'
import { DatabaseManager } from '../database'
import { DbReadClient } from './db-read-client'

vi.mock('../task-api-server', () => ({ startTaskApiServer: vi.fn(async () => 1234) }))

/**
 * Runs the REAL worker entry: it is bundled with Vite (as electron-vite does
 * for out/main/db-read-worker.js) and started with worker_threads against a
 * file database created by the production initialize().
 */
describe('DbReadClient (read-only worker connection)', { timeout: 60_000 }, () => {
  let dir: string
  let workerScript: string
  const workerOutDir = resolve(__dirname, '../../../node_modules/.cache/20x-db-read-worker-test')
  let db: DatabaseManager
  const clients: DbReadClient[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), '20x-db-read-'))
    await build({
      logLevel: 'silent',
      configFile: false,
      build: {
        // Inside the repo so the worker resolves better-sqlite3 from node_modules.
        outDir: workerOutDir,
        emptyOutDir: true,
        ssr: true,
        minify: false,
        lib: { entry: resolve(__dirname, 'db-read-worker.ts'), formats: ['cjs'], fileName: () => 'db-read-worker.js' },
        rollupOptions: { external: ['better-sqlite3', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)] }
      }
    })
    workerScript = join(workerOutDir, 'db-read-worker.js')

    vi.mocked(app.getPath).mockReturnValue(dir)
    vi.stubEnv('TWENTYX_DB_READ_WORKER', '0') // this suite starts its own clients
    db = new DatabaseManager()
    db.initialize()
    vi.unstubAllEnvs()
    db.upsertTranscriptParts('task-1', [
      { id: 'u1', role: 'user', content: 'hello', partType: 'text', receivedAt: 1000 },
      { id: 't1', role: 'assistant', content: '', partType: 'tool', tool: { name: 'Bash', output: 'ok' }, receivedAt: 2000 },
      { id: 'a1', role: 'assistant', content: 'done', partType: 'text', payload: { todos: [{ id: 1 }] }, receivedAt: 3000 }
    ])
  })

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()))
  })

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(workerOutDir, { recursive: true, force: true })
  })

  function client(options: Partial<ConstructorParameters<typeof DbReadClient>[0]> = {}): DbReadClient {
    const c = new DbReadClient({
      dbPath: join(dir, 'pf-desktop.db'),
      scriptPath: workerScript,
      fallback: { getTranscriptParts: vi.fn((taskId: string, sinceSeq?: number) => db.getTranscriptParts(taskId, sinceSeq)) },
      ...options
    })
    clients.push(c)
    return c
  }

  it('returns the same records as the main connection, without using the fallback', async () => {
    const c = client()
    await expect(c.getTranscriptParts('task-1')).resolves.toEqual(db.getTranscriptParts('task-1'))
    await expect(c.getTranscriptParts('task-1', 1)).resolves.toEqual(db.getTranscriptParts('task-1', 1))
    await expect(c.getTranscriptParts('missing')).resolves.toEqual([])
    expect(c.active).toBe(true)
  })

  it('sees writes the main connection committed before the read', async () => {
    const c = client()
    await c.getTranscriptParts('task-1')
    db.upsertTranscriptParts('task-1', [{ id: 'a2', role: 'assistant', content: 'later', partType: 'text', receivedAt: 4000 }])
    const parts = await c.getTranscriptParts('task-1')
    expect(parts.map((p) => p.partId)).toContain('a2')
    expect(parts).toEqual(db.getTranscriptParts('task-1'))
  })

  it('serves reads from the main connection when the worker cannot start', async () => {
    const fallback = { getTranscriptParts: vi.fn(() => db.getTranscriptParts('task-1')) }
    const c = client({ scriptPath: join(dir, 'does-not-exist.js'), fallback })
    await expect(c.getTranscriptParts('task-1')).resolves.toEqual(db.getTranscriptParts('task-1'))
    expect(fallback.getTranscriptParts).toHaveBeenCalled()
    expect(c.active).toBe(false)
  })

  it('falls back when the worker dies with a read in flight', async () => {
    const fallback = { getTranscriptParts: vi.fn(() => []) }
    const c = client({
      fallback,
      createWorker: () => new Worker("require('node:worker_threads').parentPort.on('message', () => process.exit(3))", { eval: true })
    })
    await expect(c.getTranscriptParts('task-1')).resolves.toEqual([])
    expect(fallback.getTranscriptParts).toHaveBeenCalledWith('task-1', undefined)
    expect(c.active).toBe(false)
  })

  it('falls back when the worker reports a read error', async () => {
    const fallback = { getTranscriptParts: vi.fn(() => []) }
    const c = client({
      fallback,
      createWorker: () => new Worker(
        "const { parentPort } = require('node:worker_threads'); parentPort.on('message', (m) => parentPort.postMessage({ id: m.id, ok: false, error: 'SQLITE_BUSY' }))",
        { eval: true }
      )
    })
    await expect(c.getTranscriptParts('task-1')).resolves.toEqual([])
    expect(fallback.getTranscriptParts).toHaveBeenCalledTimes(1)
    // One failed read does not disable the worker.
    expect(c.active).toBe(true)
  })

  it('DatabaseManager.getTranscriptPartsAsync matches the sync read when the worker is off', async () => {
    await expect(db.getTranscriptPartsAsync('task-1')).resolves.toEqual(db.getTranscriptParts('task-1'))
  })
})
