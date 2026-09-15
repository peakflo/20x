import { describe, expect, it } from 'vitest'
import { MAX_IPC_MESSAGE_BYTES, measureIpcMessage } from './ipc-message-size'

describe('IPC size preflight', () => {
  it('rejects a huge rope string without flattening or serializing it', () => {
    const content = 'あ'.repeat(256 * 1024 * 1024)
    expect(measureIpcMessage({ content }).reason).toBe('size')
  })

  it('counts repeated strings separately and allows object cycles', () => {
    const content = 'x'.repeat(MAX_IPC_MESSAGE_BYTES / 4)
    expect(measureIpcMessage({ first: content, second: content }).reason).toBe('size')
    const cycle: Record<string, unknown> = { text: 'hello' }
    cycle.self = cycle
    expect(measureIpcMessage(cycle).reason).toBeUndefined()
  })

  it('counts the backing store of binary slices, once per buffer', () => {
    const buffer = new ArrayBuffer(MAX_IPC_MESSAGE_BYTES + 1)
    expect(measureIpcMessage(new Uint8Array(buffer, 0, 1)).reason).toBe('size')
    const small = new ArrayBuffer(1024)
    expect(measureIpcMessage([new Uint8Array(small), new Uint8Array(small)]).bytes).toBeLessThan(2048)
  })

  it('uses native buffer sizes and collection entries despite shadowed properties', () => {
    const buffer = new ArrayBuffer(MAX_IPC_MESSAGE_BYTES + 1)
    Object.defineProperty(buffer, 'byteLength', { get() { throw new Error('must not run') } })
    const view = new Uint8Array(buffer, 0, 1)
    Object.defineProperty(view, 'buffer', { get() { throw new Error('must not run') } })
    expect(measureIpcMessage(view).reason).toBe('size')
    const map = new Map([['large', 'x'.repeat(MAX_IPC_MESSAGE_BYTES)]])
    map[Symbol.iterator] = () => new Map([['fake', 'small']]).entries()
    expect(measureIpcMessage(map).reason).toBe('size')
  })

  it('does not run getters, toJSON, or proxy traps', () => {
    let called = false
    const getter = { get content() { called = true; return 'x' } }
    const json = { toJSON() { called = true; return 'x' } }
    const proxy = new Proxy({}, { ownKeys() { called = true; return [] } })
    for (const value of [getter, json, proxy]) {
      expect(measureIpcMessage(value).reason).toBe('unsupported')
    }
    expect(called).toBe(false)
  })

  it('bounds depth and array length', () => {
    let value: unknown = null
    for (let i = 0; i < 1000; i++) value = { value }
    expect(measureIpcMessage(value).reason).toBe('complexity')
    expect(measureIpcMessage(new Array(1_000_000)).reason).toBe('complexity')
  })

  it('measures map and set entries and accepts supported scalar objects', () => {
    expect(measureIpcMessage(new Map([['key', 'x'.repeat(MAX_IPC_MESSAGE_BYTES)]])).reason).toBe('size')
    expect(measureIpcMessage(new Set(['x'.repeat(MAX_IPC_MESSAGE_BYTES)])).reason).toBe('size')
    expect(measureIpcMessage([new Date(), /hello/g, null, undefined, 1, true]).reason).toBeUndefined()
  })
})
