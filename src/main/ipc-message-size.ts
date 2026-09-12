import { types } from 'node:util'

// Leave ample room for V8/Electron buffer growth. This is a conservative cost,
// not the wire size. Do not serialize to measure: that can cause the same crash.
export const MAX_IPC_MESSAGE_BYTES = 8 * 1024 * 1024
export const MAX_IPC_BATCH_BYTES = 64 * 1024 * 1024
const MAX_VALUES = 100_000
const MAX_DEPTH = 64
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!
const sharedBufferLength = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!
const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!

export interface MessageSize {
  bytes: number
  reason?: 'size' | 'complexity' | 'unsupported'
}

export function measureIpcMessage(value: unknown, limit = MAX_IPC_MESSAGE_BYTES): MessageSize {
  let bytes = 64
  let values = 0
  let reason: MessageSize['reason']
  const seen = new WeakSet<object>()
  const add = (size: number): void => {
    bytes += size
    if (bytes > limit) reason = 'size'
  }
  const visit = (item: unknown, depth: number): void => {
    if (reason) return
    if (++values > MAX_VALUES || depth > MAX_DEPTH) {
      reason = 'complexity'
      return
    }
    add(32)
    if (typeof item === 'string') { add(item.length * 2); return }
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') {
      reason = 'unsupported'
      return
    }
    if (item === null || typeof item !== 'object') return
    if (types.isProxy(item)) { reason = 'unsupported'; return }
    if (seen.has(item)) return
    seen.add(item)
    if (item instanceof ArrayBuffer || item instanceof SharedArrayBuffer) {
      add((item instanceof ArrayBuffer ? arrayBufferLength : sharedBufferLength).call(item))
      return
    }
    if (ArrayBuffer.isView(item)) {
      // Views may serialize their whole backing store, not just the slice.
      visit((item instanceof DataView ? dataViewBuffer : typedArrayBuffer).call(item), depth + 1)
      return
    }
    if (item instanceof Date) return
    if (item instanceof RegExp) { add(regexpSource.call(item).length * 2); return }
    if (item instanceof Map) {
      for (const [key, value] of Map.prototype.entries.call(item)) {
        visit(key, depth + 1)
        visit(value, depth + 1)
        if (reason) break
      }
      return
    }
    if (item instanceof Set) {
      for (const value of Set.prototype.values.call(item)) {
        visit(value, depth + 1)
        if (reason) break
      }
      return
    }
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      reason = 'unsupported'
      return
    }
    if (Array.isArray(item) && item.length > MAX_VALUES) {
      reason = 'complexity'
      return
    }
    // Do not build an Object.keys array or invoke getters/toJSON. Stop as soon
    // as the budget is exhausted, including on deeply nested or cyclic input.
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!('value' in descriptor)) { reason = 'unsupported'; break }
      add(key.length * 2 + 16)
      visit(descriptor.value, depth + 1)
      if (reason) break
    }
  }
  visit(value, 0)
  return { bytes, ...(reason ? { reason } : {}) }
}
