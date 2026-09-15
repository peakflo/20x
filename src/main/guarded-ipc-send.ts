import { types } from 'node:util'
import { app, dialog, type WebContents } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_IPC_BATCH_BYTES, MAX_IPC_MESSAGE_BYTES, MAX_IPC_VALUES, measureIpcMessage } from './ipc-message-size'

let lastNoticeAt = -Infinity

function record(channel: string, bytes: number, result: string): void {
  try {
    const directory = join(app.getPath('userData'), 'logs')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'ipc-guard.log')
    if (existsSync(path) && statSync(path).size > 1024 * 1024) renameSync(path, `${path}.1`)
    // Channel names are application constants. Never record message contents,
    // even when they are malformed or contain credentials/tool output.
    appendFileSync(path, JSON.stringify({
      time: new Date().toISOString(), channel: channel.slice(0, 160),
      estimatedBytes: bytes, result, rss: process.memoryUsage().rss
    }) + '\n')
  } catch { /* Disk failure must not bypass the send guard. */ }
}

function reject(channel: string, bytes: number, reason: string): false {
  record(channel, bytes, `blocked:${reason}`)
  const now = Date.now()
  if (now - lastNoticeAt >= 60_000) {
    lastNoticeAt = now
    try {
      void Promise.resolve(dialog.showMessageBox({
        type: 'error', title: '20x — Update could not be displayed',
        message: 'An update is too large or too complex to display safely.',
        detail: '20x stopped this update to prevent a crash. Saved task data has not been changed. A diagnostic record was saved in logs/ipc-guard.log.',
        buttons: ['OK']
      })).catch(() => {})
    } catch { /* The app may be shutting down. */ }
  }
  return false
}

/** Protect explicit main-to-renderer sends before Electron's native serializer.
 * Oversized single records are rejected, never truncated or removed from storage.
 * Invoke responses and mobile WebSocket delivery are separate transports.
 */
export function guardedIpcSend(
  target: Pick<WebContents, 'send'> | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!target) return false
  const size = measureIpcMessage([channel, ...args])
  if (!size.reason) {
    if (size.bytes >= 1024 * 1024) record(channel, size.bytes, 'sending')
    target.send(channel, ...args)
    return true
  }

  // Only split known event contracts. Never split arbitrary objects or strings.
  // Preflight the WHOLE batch before sending any chunk: a rejected part must not
  // advance the renderer revision past data it has not received.
  if ((size.reason === 'size' || size.reason === 'complexity') && args.length === 1 &&
      (channel === 'transcript:changed' || channel === 'agent:output-batch')) {
    const payload = args[0]
    if (!payload || typeof payload !== 'object' || types.isProxy(payload) || Object.getPrototypeOf(payload) !== Object.prototype) {
      return reject(channel, size.bytes, 'unsupported')
    }
    const field = channel === 'transcript:changed' ? 'parts' : 'messages'
    const parts = Object.getOwnPropertyDescriptor(payload, field)?.value
    if (Array.isArray(parts) && !types.isProxy(parts) && parts.length > 1 && parts.length <= MAX_IPC_VALUES) {
      const envelope: Record<string, unknown> = { [field]: [] }
      let keys = 0
      for (const key in payload) {
        if (!Object.hasOwn(payload, key) || key === field) continue
        const descriptor = Object.getOwnPropertyDescriptor(payload, key)!
        if (++keys > 1000 || !('value' in descriptor)) return reject(channel, size.bytes, 'unsupported')
        Object.defineProperty(envelope, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true })
      }
      const envelopeSize = measureIpcMessage([channel, envelope])
      if (envelopeSize.reason) return reject(channel, envelopeSize.bytes, envelopeSize.reason)
      const overhead = envelopeSize.bytes
      const chunks: unknown[][] = []
      let chunk: unknown[] = []
      let cost = overhead
      let totalCost = overhead
      let values = envelopeSize.values
      for (let index = 0; index < parts.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(parts, String(index))
        if (!descriptor || !('value' in descriptor)) return reject(channel, totalCost, 'unsupported')
        const part = descriptor.value
        const partSize = measureIpcMessage(part)
        // Allow for array keys and container framing, counted per part.
        const partCost = partSize.bytes + 64
        totalCost += partCost
        // Splitting loses object-reference deduplication between chunks. Bound
        // that expanded cost too, not only the original graph's wire estimate.
        if (totalCost > MAX_IPC_BATCH_BYTES) return reject(channel, totalCost, 'size')
        if (partSize.reason || overhead + partCost > MAX_IPC_MESSAGE_BYTES || envelopeSize.values + partSize.values > MAX_IPC_VALUES) {
          return reject(channel, overhead + partCost, partSize.reason || 'size')
        }
        if (cost + partCost > MAX_IPC_MESSAGE_BYTES || values + partSize.values > MAX_IPC_VALUES) {
          chunks.push(chunk)
          chunk = []
          cost = overhead
          values = envelopeSize.values
        }
        chunk.push(part)
        cost += partCost
        values += partSize.values
      }
      chunks.push(chunk)
      record(channel, totalCost, `splitting:${chunks.length}`)
      for (let index = 0; index < chunks.length; index++) {
        const message = { ...envelope, [field]: chunks[index] }
        // Do not claim the final revision until every chunk has been sent.
        // The renderer keeps its current cursor for intermediate events.
        if (channel === 'transcript:changed' && index < chunks.length - 1) message.maxRev = 0
        target.send(channel, message)
      }
      return true
    }
  }
  return reject(channel, size.bytes, size.reason)
}
