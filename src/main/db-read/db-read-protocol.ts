/** Messages between the main process and the read-only DB worker. */

export interface DbReadWorkerData {
  dbPath: string
}

export type DbReadRequest =
  | { id: number; op: 'getTranscriptParts'; taskId: string; sinceSeq?: number }

export type DbReadResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
