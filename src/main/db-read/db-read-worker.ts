/**
 * Worker-thread entry: a READ-ONLY better-sqlite3 connection that serves heavy
 * reads off the Electron main thread.
 *
 * The database runs in WAL mode, so this reader sees every transaction the main
 * connection has committed when the read starts, and never blocks the writer.
 * It must never write: the main connection stays the only writer.
 *
 * Built as its own entry (`out/main/db-read-worker.js`); see db-read-client.ts.
 */
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { readTranscriptParts } from './transcript-query'
import type { DbReadRequest, DbReadResponse, DbReadWorkerData } from './db-read-protocol'

const { dbPath } = workerData as DbReadWorkerData
const db = new Database(dbPath, { readonly: true, fileMustExist: true })
db.pragma('busy_timeout = 5000')

function handle(request: DbReadRequest): unknown {
  switch (request.op) {
    case 'getTranscriptParts':
      return readTranscriptParts(db, request.taskId, request.sinceSeq)
    default:
      throw new Error(`Unknown db-read op: ${(request as { op: string }).op}`)
  }
}

parentPort!.on('message', (request: DbReadRequest) => {
  let response: DbReadResponse
  try {
    response = { id: request.id, ok: true, result: handle(request) }
  } catch (err) {
    response = { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  parentPort!.postMessage(response)
})
