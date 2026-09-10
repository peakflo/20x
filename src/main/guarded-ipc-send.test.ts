import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { guardedIpcSend } from './guarded-ipc-send'
import { MAX_IPC_MESSAGE_BYTES, measureIpcMessage } from './ipc-message-size'

afterEach(() => vi.restoreAllMocks())

describe('guarded desktop sends', () => {
  it('keeps channel, arguments, and object identity for normal events', () => {
    const send = vi.fn()
    const data = { taskId: 'task-1', status: 'idle' }
    expect(guardedIpcSend({ send }, 'agent:status', data, 42)).toBe(true)
    expect(send.mock.calls).toEqual([['agent:status', data, 42]])
    expect(send.mock.calls[0][1]).toBe(data)
    expect(guardedIpcSend(null, 'unused')).toBe(false)
  })

  it('blocks excessive allocations before native send and logs metadata only', () => {
    const directory = mkdtempSync(join(tmpdir(), '20x-ipc-guard-'))
    vi.mocked(app.getPath).mockReturnValue(directory)
    const send = vi.fn()
    const data = { content: 'SECRET-MESSAGE'.repeat(MAX_IPC_MESSAGE_BYTES) }
    expect(guardedIpcSend({ send }, 'agent:output', data)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    const log = readFileSync(join(directory, 'logs/ipc-guard.log'), 'utf8')
    expect(log).toContain('agent:output')
    expect(log).toContain('blocked:size')
    expect(log).not.toContain('SECRET-MESSAGE')
    expect(dialog.showMessageBox).toHaveBeenCalled()
    expect(data.content.length).toBe(14 * MAX_IPC_MESSAGE_BYTES)
  })

  it('splits transcript deltas without losing data or advancing the cursor early', () => {
    const send = vi.fn()
    const parts = Array.from({ length: 12 }, (_, index) => ({
      partId: String(index), rev: index + 1, content: 'あ'.repeat(400_000)
    }))
    const payload = { taskId: 'task-1', parts, maxRev: 12 }
    expect(guardedIpcSend({ send }, 'transcript:changed', payload)).toBe(true)
    expect(send.mock.calls.length).toBeGreaterThan(1)
    expect(send.mock.calls.flatMap(([, data]) => data.parts)).toEqual(parts)
    for (const call of send.mock.calls) expect(measureIpcMessage(call).reason).toBeUndefined()
    expect(send.mock.calls.slice(0, -1).every(([, data]) => data.maxRev === 0)).toBe(true)
    expect(send.mock.calls.at(-1)![1].maxRev).toBe(12)
    expect(payload.parts).toBe(parts)
    expect(payload.maxRev).toBe(12)
  })

  it('splits legacy output batches and retains routing fields', () => {
    const send = vi.fn()
    const messages = Array.from({ length: 12 }, (_, id) => ({ id, content: 'x'.repeat(400_000) }))
    expect(guardedIpcSend({ send }, 'agent:output-batch', {
      taskId: 'task-1', sessionId: 'session-1', messages
    })).toBe(true)
    expect(send.mock.calls.flatMap(([, data]) => data.messages)).toEqual(messages)
    expect(send.mock.calls.every(([, data]) => data.taskId === 'task-1' && data.sessionId === 'session-1')).toBe(true)
  })

  it('preflights all parts before sending a batch with one excessive item', () => {
    const send = vi.fn()
    const parts = [{ content: 'ok' }, { content: 'x'.repeat(MAX_IPC_MESSAGE_BYTES) }]
    expect(guardedIpcSend({ send }, 'transcript:changed', { taskId: 't', parts, maxRev: 2 })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('bounds amplification from repeated references when splitting', () => {
    const send = vi.fn()
    const shared = { content: 'x'.repeat(1_000_000) }
    const messages = [...Array(100).fill(shared), { content: 'x'.repeat(3_500_000) }]
    expect(guardedIpcSend({ send }, 'agent:output-batch', { messages })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects an aggregate batch over the total budget', () => {
    const send = vi.fn()
    const messages = Array.from({ length: 100 }, () => ({ content: 'x'.repeat(400_000) }))
    expect(guardedIpcSend({ send }, 'agent:output-batch', { messages })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('does not let unsupported values reach native serialization', () => {
    const send = vi.fn()
    expect(guardedIpcSend({ send }, 'custom', { callback() {} })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('routes every explicit WebContents send through the guard', () => {
    const files = readdirSync(__dirname).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    for (const file of files) {
      if (file === 'guarded-ipc-send.ts') continue
      const source = readFileSync(join(__dirname, file), 'utf8')
      expect(source, file).not.toMatch(/(?:webContents|sender)(?:\?\.|\.)send\(/)
    }
  })
})
