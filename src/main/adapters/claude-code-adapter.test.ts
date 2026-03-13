/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

// Mock the SDK before importing the adapter
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}))

// Mock child_process and fs to avoid real filesystem operations
vi.mock('child_process', () => ({ execFile: vi.fn() }))
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }))

import { ClaudeCodeAdapter } from './claude-code-adapter'

/**
 * Helper: creates an adapter with a pre-populated session so we can test
 * pollMessages / getStatus without going through the full SDK stream flow.
 */
function createAdapterWithSession(
  sessionId: string,
  messages: any[],
  opts?: { status?: 'idle' | 'busy' | 'error'; lastError?: string | null }
) {
  const adapter = new ClaudeCodeAdapter()
  const session = {
    sessionId,
    queryIterator: null,
    abortController: null,
    status: opts?.status ?? 'idle',
    messageBuffer: messages,
    messageCursor: 0,
    streamTask: null,
    lastError: opts?.lastError ?? null,
    config: {} as any,
  }
  ;(adapter as any).sessions.set(sessionId, session)
  return { adapter, session }
}

describe('ClaudeCodeAdapter error result handling', () => {
  describe('consumeStream error extraction', () => {
    // We test the error extraction logic indirectly by simulating what consumeStream does:
    // pushing error result messages into the buffer and checking getStatus/pollMessages.

    it('extracts error text from result field when it is a string', async () => {
      const errorMsg = {
        type: 'result',
        is_error: true,
        result: 'Rate limit exceeded. Please try again in 30 seconds.',
        uuid: 'err-1',
      }
      const { adapter } = createAdapterWithSession('s1', [errorMsg], {
        status: 'error',
        lastError: 'Rate limit exceeded. Please try again in 30 seconds.',
      })

      const status = await adapter.getStatus('s1', {} as any)
      expect(status.type).toBe('error')
      expect(status.message).toBe('Rate limit exceeded. Please try again in 30 seconds.')
    })

    it('surfaces error result messages in pollMessages when result is a string', async () => {
      const errorMsg = {
        type: 'result',
        is_error: true,
        result: 'Rate limit exceeded',
        uuid: 'err-2',
      }
      const { adapter } = createAdapterWithSession('s1', [errorMsg])

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()
      const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

      const errorPart = parts.find((p: any) => p.text?.includes('Rate limit'))
      expect(errorPart).toBeDefined()
      expect(errorPart!.text).toBe('Rate limit exceeded')
    })

    it('surfaces error result messages when errors array is present', async () => {
      const errorMsg = {
        type: 'result',
        is_error: true,
        errors: ['Connection timeout', 'Retry failed'],
        uuid: 'err-3',
      }
      const { adapter } = createAdapterWithSession('s1', [errorMsg])

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()
      const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

      const errorPart = parts.find((p: any) => p.text?.includes('Connection timeout'))
      expect(errorPart).toBeDefined()
      expect(errorPart!.text).toBe('Connection timeout; Retry failed')
    })

    it('surfaces error result messages when result is an object', async () => {
      const errorMsg = {
        type: 'result',
        is_error: true,
        result: { code: 'RATE_LIMIT', message: 'Too many requests' },
        uuid: 'err-4',
      }
      const { adapter } = createAdapterWithSession('s1', [errorMsg])

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()
      const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

      const errorPart = parts.find((p: any) => p.text?.includes('RATE_LIMIT'))
      expect(errorPart).toBeDefined()
      expect(errorPart!.text).toContain('Too many requests')
    })

    it('surfaces fallback error text when no details available', async () => {
      const errorMsg = {
        type: 'result',
        is_error: true,
        uuid: 'err-5',
      }
      const { adapter } = createAdapterWithSession('s1', [errorMsg])

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()
      const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

      const errorPart = parts.find((p: any) => p.role === 'system')
      expect(errorPart).toBeDefined()
      expect(errorPart!.text).toBe('An error occurred (no details available)')
    })

    it('uses error field when result and errors are absent', async () => {
      const errorMsg = {
        type: 'result',
        is_error: true,
        error: 'Internal server error',
        uuid: 'err-6',
      }
      const { adapter } = createAdapterWithSession('s1', [errorMsg])

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()
      const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

      const errorPart = parts.find((p: any) => p.text?.includes('Internal server error'))
      expect(errorPart).toBeDefined()
      expect(errorPart!.text).toBe('Internal server error')
    })

    it('does not surface error part for non-error result messages', async () => {
      const successMsg = {
        type: 'result',
        is_error: false,
        result: 'Task completed successfully',
        uuid: 'ok-1',
      }
      const { adapter } = createAdapterWithSession('s1', [successMsg])

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()
      const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

      const errorPart = parts.find((p: any) => p.role === 'system' && p.text?.includes('error'))
      expect(errorPart).toBeUndefined()
    })
  })

  describe('getStatus with lastError', () => {
    it('returns error status with lastError message', async () => {
      const { adapter } = createAdapterWithSession('s1', [], {
        status: 'error',
        lastError: 'Rate limit exceeded',
      })

      const status = await adapter.getStatus('s1', {} as any)
      expect(status.type).toBe('error')
      expect(status.message).toBe('Rate limit exceeded')
    })

    it('returns idle status when no error', async () => {
      const { adapter } = createAdapterWithSession('s1', [], {
        status: 'idle',
        lastError: null,
      })

      const status = await adapter.getStatus('s1', {} as any)
      expect(status.type).toBe('idle')
    })

    it('returns error for non-existent session', async () => {
      const adapter = new ClaudeCodeAdapter()
      const status = await adapter.getStatus('nonexistent', {} as any)
      expect(status.type).toBe('error')
      expect(status.message).toBe('Session not found')
    })
  })
})
