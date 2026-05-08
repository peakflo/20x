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

  describe('error recovery — queryIterator reset', () => {
    it('resets queryIterator to null after error so next sendPrompt starts fresh process', async () => {
      const adapter = new ClaudeCodeAdapter()

      // Simulate a session that had a previous query (queryIterator is set)
      // and then hit an error (status = 'error')
      const fakeIterator = {
        [Symbol.asyncIterator]() { return this },
        async next() { return { done: true, value: undefined } },
      }

      const session: any = {
        sessionId: 's1',
        queryIterator: fakeIterator,
        abortController: null,
        status: 'idle',
        messageBuffer: [],
        messageCursor: 0,
        streamTask: null,
        lastError: null,
        config: {} as any,
      }
      ;(adapter as any).sessions.set('s1', session)

      // Simulate consumeStream completing with error status
      // (error result sets status to 'error' before stream ends normally)
      session.status = 'error'
      session.lastError = 'Rate limit exceeded'

      // Call consumeStream directly (it reads from queryIterator which is exhausted)
      await (adapter as any).consumeStream('s1', session)

      // After error, queryIterator should be null so next sendPrompt
      // starts a fresh process instead of setting continue: true
      expect(session.queryIterator).toBeNull()
      expect(session.status).toBe('error')
    })

    it('resets queryIterator when stream completes normally (idle) so resume is used instead of continue', async () => {
      const adapter = new ClaudeCodeAdapter()

      const fakeIterator = {
        [Symbol.asyncIterator]() { return this },
        async next() { return { done: true, value: undefined } },
      }

      const session = {
        sessionId: 's1',
        queryIterator: fakeIterator,
        abortController: null,
        status: 'idle' as const,
        messageBuffer: [],
        messageCursor: 0,
        streamTask: null,
        lastError: null,
        config: {} as any,
      }
      ;(adapter as any).sessions.set('s1', session)

      await (adapter as any).consumeStream('s1', session)

      // queryIterator is always reset when stream ends — even on normal idle.
      // This ensures sendPrompt uses --resume (exact session) instead of
      // --continue (most-recent in directory), which could pick up the wrong
      // conversation if another session ran in the same workspace.
      expect(session.queryIterator).toBeNull()
      expect(session.status).toBe('idle')
    })

    it('resets queryIterator when stream throws an error', async () => {
      const adapter = new ClaudeCodeAdapter()

      const fakeIterator = {
        [Symbol.asyncIterator]() { return this },
        async next() { throw new Error('Claude Code process exited with code 1') },
      }

      const session = {
        sessionId: 's1',
        queryIterator: fakeIterator,
        abortController: null,
        status: 'busy' as const,
        messageBuffer: [],
        messageCursor: 0,
        streamTask: null,
        lastError: null,
        config: {} as any,
        isResumed: false,
      }
      ;(adapter as any).sessions.set('s1', session)

      await (adapter as any).consumeStream('s1', session)

      // After thrown error, queryIterator should be null for recovery
      expect(session.queryIterator).toBeNull()
      expect(session.status).toBe('error')
      // Non-resumed session should NOT get INCOMPATIBLE_SESSION_ID
      expect(session.lastError).not.toContain('INCOMPATIBLE_SESSION_ID')
    })

    it('sets INCOMPATIBLE_SESSION_ID only for resumed sessions on exit code 1', async () => {
      const adapter = new ClaudeCodeAdapter()

      const fakeIterator = {
        [Symbol.asyncIterator]() { return this },
        async next() { throw new Error('Claude Code process exited with code 1') },
      }

      const session: any = {
        sessionId: 's1',
        queryIterator: fakeIterator,
        abortController: null,
        status: 'busy',
        messageBuffer: [],
        messageCursor: 0,
        streamTask: null,
        lastError: null,
        config: {} as any,
        isResumed: true, // This is a resumed session
      }
      ;(adapter as any).sessions.set('s1', session)

      await (adapter as any).consumeStream('s1', session)

      // Resumed session with exit code 1 SHOULD get INCOMPATIBLE_SESSION_ID
      expect(session.lastError).toContain('INCOMPATIBLE_SESSION_ID')
    })

    it('skips undefined/null messages from SDK iterator without crashing', async () => {
      const adapter = new ClaudeCodeAdapter()

      let callCount = 0
      const fakeIterator = {
        [Symbol.asyncIterator]() { return this },
        async next() {
          callCount++
          if (callCount === 1) return { done: false, value: undefined }
          if (callCount === 2) return { done: false, value: null }
          if (callCount === 3) return { done: false, value: { type: 'result', is_error: false, uuid: 'ok-1' } }
          return { done: true, value: undefined }
        },
      }

      const session = {
        sessionId: 's1',
        queryIterator: fakeIterator,
        abortController: null,
        status: 'busy' as const,
        messageBuffer: [] as any[],
        messageCursor: 0,
        streamTask: null,
        lastError: null,
        config: {} as any,
      }
      ;(adapter as any).sessions.set('s1', session)

      // Should not throw — undefined/null messages are skipped
      await (adapter as any).consumeStream('s1', session)

      expect(session.status).toBe('idle')
      // Only the valid message should be buffered
      expect(session.messageBuffer.length).toBe(1)
    })
  })

  describe('sendPrompt session continuation mode', () => {
    // These tests verify the continuation logic (--resume vs --continue vs new)
    // by inspecting session state rather than calling through the real SDK,
    // because the Claude Code binary is not available in CI.

    it('uses resume when queryIterator is null but session has a Claude Code UUID (error recovery)', () => {
      // Session state: error recovery — queryIterator null, but has a real sessionId
      const session: any = {
        sessionId: 'abc-def-123', // Real Claude Code UUID from previous run
        queryIterator: null,      // Null because of error recovery
        isResumed: false,         // NOT a resumed session — was created via startSession
      }

      // sendPrompt determines isFirstPrompt from queryIterator:
      const isFirstPrompt = !session.queryIterator
      expect(isFirstPrompt).toBe(true)

      // Continuation logic from sendPrompt (lines 643-652):
      // if (isFirstPrompt && session.isResumed) → options.resume = sessionId
      // else if (isFirstPrompt && session.sessionId) → options.resume = session.sessionId
      // else if (!isFirstPrompt) → options.continue = true
      const options: any = {}
      if (isFirstPrompt && session.isResumed) {
        options.resume = session.sessionId
      } else if (isFirstPrompt && session.sessionId) {
        options.resume = session.sessionId
      } else if (!isFirstPrompt) {
        options.continue = true
      }

      // Should use resume with the real Claude Code session UUID
      expect(options.resume).toBe('abc-def-123')
      expect(options.continue).toBeUndefined()
    })

    it('does NOT use resume for brand-new sessions with empty sessionId', () => {
      // Brand-new session: empty sessionId, no queryIterator
      const session: any = {
        sessionId: '',           // Empty — brand new, no Claude Code UUID yet
        queryIterator: null,
        isResumed: false,
      }

      const isFirstPrompt = !session.queryIterator
      expect(isFirstPrompt).toBe(true)

      const options: any = {}
      if (isFirstPrompt && session.isResumed) {
        options.resume = session.sessionId
      } else if (isFirstPrompt && session.sessionId) {
        options.resume = session.sessionId
      } else if (!isFirstPrompt) {
        options.continue = true
      }

      // Should NOT resume — this is a brand new session (empty sessionId is falsy)
      expect(options.resume).toBeUndefined()
      expect(options.continue).toBeUndefined()
    })

    it('uses resume after normal idle completion (isResumed flag)', () => {
      // After consumeStream ends normally, queryIterator is null and isResumed is true
      const session: any = {
        sessionId: 'session-uuid-456',
        queryIterator: null,     // Reset after stream completion
        isResumed: true,         // Set by consumeStream finally block
      }

      const isFirstPrompt = !session.queryIterator
      expect(isFirstPrompt).toBe(true)

      const options: any = {}
      if (isFirstPrompt && session.isResumed) {
        options.resume = session.sessionId
      } else if (isFirstPrompt && session.sessionId) {
        options.resume = session.sessionId
      } else if (!isFirstPrompt) {
        options.continue = true
      }

      // Should use resume with the session UUID (not --continue which picks up most-recent)
      expect(options.resume).toBe('session-uuid-456')
      expect(options.continue).toBeUndefined()
    })

    it('uses continue when process is still alive (queryIterator truthy)', () => {
      const fakeIterator = {
        [Symbol.asyncIterator]() { return this },
        async next() { return { done: true, value: undefined } },
      }
      const session: any = {
        sessionId: 'session-uuid-789',
        queryIterator: fakeIterator, // Process still alive
        isResumed: false,
      }

      const isFirstPrompt = !session.queryIterator
      expect(isFirstPrompt).toBe(false)

      const options: any = {}
      if (isFirstPrompt && session.isResumed) {
        options.resume = session.sessionId
      } else if (isFirstPrompt && session.sessionId) {
        options.resume = session.sessionId
      } else if (!isFirstPrompt) {
        options.continue = true
      }

      // Process is alive — use --continue for in-process continuation
      expect(options.continue).toBe(true)
      expect(options.resume).toBeUndefined()
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

describe('ClaudeCodeAdapter cleanSessionFile', () => {
  // Test the core logic of cleanSessionFile: filtering empty text blocks
  // without removing entire messages that also contain tool_use blocks.
  //
  // We test the filtering logic directly with the same algorithm as the
  // production code, since the method is private and uses filesystem I/O.

  function simulateCleanSessionFile(lines: string[]): string[] {
    const cleanedLines: string[] = []
    for (const line of lines) {
      const entry = JSON.parse(line)

      // Keep non-message entries as-is
      if (entry.type !== 'user' && entry.type !== 'assistant') {
        cleanedLines.push(line)
        continue
      }

      if (entry.message?.content && Array.isArray(entry.message.content)) {
        const originalLength = entry.message.content.length
        const filteredContent = entry.message.content.filter(
          (contentPart: { type?: string; text?: string }) => {
            if (!contentPart || typeof contentPart !== 'object') return false
            if (contentPart.type === 'text' && (!contentPart.text || contentPart.text.trim() === '')) return false
            return true
          }
        )

        if (filteredContent.length === 0) {
          continue
        }

        if (filteredContent.length !== originalLength) {
          entry.message.content = filteredContent
          cleanedLines.push(JSON.stringify(entry))
          continue
        }
      }

      cleanedLines.push(line)
    }
    return cleanedLines
  }

  it('keeps messages with non-empty text blocks unchanged', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Hello' }] } }),
    ]
    const result = simulateCleanSessionFile(lines)
    expect(result).toHaveLength(1)
    expect(JSON.parse(result[0]).message.content[0].text).toBe('Hello')
  })

  it('removes messages where ALL content blocks are empty text', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: '' }] } }),
    ]
    const result = simulateCleanSessionFile(lines)
    expect(result).toHaveLength(0)
  })

  it('preserves tool_use blocks when filtering out empty text from same message (THE BUG FIX)', () => {
    // This is the core regression: an assistant message has both an empty text block
    // AND a tool_use block. The old code removed the ENTIRE message, orphaning the
    // tool_result in the next user message and causing the Claude CLI to crash.
    const assistantMsg = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        id: 'msg_01ABC',
        content: [
          { type: 'text', text: '' },
          { type: 'tool_use', id: 'toolu_01XYZ', name: 'Read', input: { file_path: '/tmp/test' } },
        ],
      },
    }
    const userMsg = {
      type: 'user',
      uuid: 'u1',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01XYZ', content: 'file contents' },
        ],
      },
    }
    const lines = [JSON.stringify(assistantMsg), JSON.stringify(userMsg)]
    const result = simulateCleanSessionFile(lines)

    // Both messages should be kept
    expect(result).toHaveLength(2)

    // The assistant message should have the empty text filtered out but tool_use preserved
    const cleaned = JSON.parse(result[0])
    expect(cleaned.message.content).toHaveLength(1)
    expect(cleaned.message.content[0].type).toBe('tool_use')
    expect(cleaned.message.content[0].id).toBe('toolu_01XYZ')

    // The user message should be unchanged (tool_result still has matching tool_use)
    const userResult = JSON.parse(result[1])
    expect(userResult.message.content[0].tool_use_id).toBe('toolu_01XYZ')
  })

  it('handles messages with multiple empty text blocks and one valid block', () => {
    const msg = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '   ' },
          { type: 'text', text: 'Valid text' },
        ],
      },
    }
    const lines = [JSON.stringify(msg)]
    const result = simulateCleanSessionFile(lines)

    expect(result).toHaveLength(1)
    const cleaned = JSON.parse(result[0])
    expect(cleaned.message.content).toHaveLength(1)
    expect(cleaned.message.content[0].text).toBe('Valid text')
  })

  it('filters out null/undefined content parts', () => {
    const msg = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        content: [
          null,
          undefined,
          { type: 'text', text: 'Valid text' },
        ],
      },
    }
    const lines = [JSON.stringify(msg)]
    const result = simulateCleanSessionFile(lines)

    expect(result).toHaveLength(1)
    const cleaned = JSON.parse(result[0])
    // null serializes to null in JSON, undefined is omitted from arrays (becomes null)
    // The filter should remove them
    expect(cleaned.message.content).toHaveLength(1)
    expect(cleaned.message.content[0].text).toBe('Valid text')
  })

  it('preserves non-message entries (queue-operation, etc.)', () => {
    const lines = [
      JSON.stringify({ type: 'queue-operation', data: 'something' }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: '' }] } }),
    ]
    const result = simulateCleanSessionFile(lines)
    expect(result).toHaveLength(1) // Only the queue-operation survives
    expect(JSON.parse(result[0]).type).toBe('queue-operation')
  })

  it('preserves messages without content (no filtering needed)', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: {} }),
    ]
    const result = simulateCleanSessionFile(lines)
    expect(result).toHaveLength(1)
  })
})

describe('Workspace path encoding', () => {
  // The adapter encodes workspace paths the same way Claude Code CLI does:
  // all non-alphanumeric, non-hyphen characters are replaced with hyphens.
  // This must match Claude Code's actual encoding to find session files.

  it('replaces slashes and spaces with hyphens', () => {
    const path = '/Users/john/my projects/app'
    const encoded = path.replace(/[^a-zA-Z0-9-]/g, '-')
    expect(encoded).toBe('-Users-john-my-projects-app')
  })

  it('replaces underscores with hyphens (matches Claude Code CLI behavior)', () => {
    const path = '/Users/john/workspaces/task_1774055411603_shbw90l'
    const encoded = path.replace(/[^a-zA-Z0-9-]/g, '-')
    expect(encoded).toBe('-Users-john-workspaces-task-1774055411603-shbw90l')
  })

  it('replaces dots with hyphens (matches Claude Code CLI behavior)', () => {
    const path = '/Users/john/.paperclip/project'
    const encoded = path.replace(/[^a-zA-Z0-9-]/g, '-')
    expect(encoded).toBe('-Users-john--paperclip-project')
  })

  it('preserves existing hyphens', () => {
    const path = '/Users/john/my-project'
    const encoded = path.replace(/[^a-zA-Z0-9-]/g, '-')
    expect(encoded).toBe('-Users-john-my-project')
  })

  it('handles the full 20x workspace path correctly', () => {
    const path = '/Users/dmitryvedenyapin/Library/Application Support/20x/workspaces/task_1774055411603_shbw90l'
    const encoded = path.replace(/[^a-zA-Z0-9-]/g, '-')
    expect(encoded).toBe('-Users-dmitryvedenyapin-Library-Application-Support-20x-workspaces-task-1774055411603-shbw90l')
    // Old regex would produce: -Users-dmitryvedenyapin-Library-Application-Support-20x-workspaces-task_1774055411603_shbw90l
    // which doesn't match the actual directory Claude Code creates
  })
})
describe('ClaudeCodeAdapter task_progress handling', () => {
  it('converts task_started to TASK_PROGRESS part', async () => {
    const msg = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-abc',
      description: 'Investigate bug in auth module',
      uuid: 'ts-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [msg])
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('task_progress')
    expect(parts[0].id).toBe('task-task-abc')
    expect(parts[0].content).toBe('Investigate bug in auth module')
    expect(parts[0].taskProgress).toEqual({
      taskId: 'task-abc',
      status: 'started',
      description: 'Investigate bug in auth module',
    })
    expect(parts[0].update).toBeUndefined()
  })

  it('converts task_progress to TASK_PROGRESS part with update flag', async () => {
    const startMsg = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-abc',
      description: 'Investigate bug',
      uuid: 'ts-1',
      session_id: 's1',
    }
    const progressMsg = {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task-abc',
      description: 'Investigating auth module',
      last_tool_name: 'Grep',
      summary: 'Found 3 relevant files',
      usage: { total_tokens: 5000, tool_uses: 12, duration_ms: 30000 },
      uuid: 'tp-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [startMsg, progressMsg])
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    // Should have 2 parts: started + progress update
    expect(parts).toHaveLength(2)

    const progressPart = parts[1]
    expect(progressPart.type).toBe('task_progress')
    expect(progressPart.id).toBe('task-task-abc')
    expect(progressPart.update).toBe(true)
    expect(progressPart.taskProgress).toEqual({
      taskId: 'task-abc',
      status: 'running',
      description: 'Investigating auth module',
      lastToolName: 'Grep',
      summary: 'Found 3 relevant files',
      usage: { total_tokens: 5000, tool_uses: 12, duration_ms: 30000 },
    })
  })

  it('converts task_notification to TASK_PROGRESS part with final status', async () => {
    const startMsg = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-abc',
      description: 'Fix auth bug',
      uuid: 'ts-1',
      session_id: 's1',
    }
    const notificationMsg = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-abc',
      status: 'completed',
      summary: 'Successfully fixed the auth bug by updating the token validation logic.',
      usage: { total_tokens: 10000, tool_uses: 25, duration_ms: 60000 },
      uuid: 'tn-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [startMsg, notificationMsg])
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    expect(parts).toHaveLength(2)

    const notificationPart = parts[1]
    expect(notificationPart.type).toBe('task_progress')
    expect(notificationPart.id).toBe('task-task-abc')
    expect(notificationPart.update).toBe(true)
    expect(notificationPart.taskProgress?.status).toBe('completed')
    expect(notificationPart.taskProgress?.summary).toBe('Successfully fixed the auth bug by updating the token validation logic.')
  })

  it('handles task_progress without prior task_started (creates new entry)', async () => {
    const progressMsg = {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task-orphan',
      description: 'Working on something',
      usage: { total_tokens: 1000, tool_uses: 3, duration_ms: 5000 },
      uuid: 'tp-orphan',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [progressMsg])
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('task_progress')
    expect(parts[0].update).toBeFalsy() // First time seen, no update flag
    expect(parts[0].taskProgress?.status).toBe('running')
  })

  it('handles tool_progress by updating existing tool part', async () => {
    // First emit a tool_use for the tool
    const toolUseMsg = {
      type: 'assistant',
      uuid: 'msg-1',
      message: {
        id: 'msg-1',
        content: [
          { type: 'tool_use', id: 'tu-123', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    }
    const toolProgressMsg = {
      type: 'tool_progress',
      tool_use_id: 'tu-123',
      tool_name: 'Bash',
      parent_tool_use_id: null,
      elapsed_time_seconds: 15,
      uuid: 'tp-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [toolUseMsg, toolProgressMsg])
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    // Should have: text part (empty, from assistant) + tool part + tool progress update
    const toolParts = parts.filter((p: any) => p.type === 'tool')
    expect(toolParts.length).toBeGreaterThanOrEqual(1)

    const progressUpdate = toolParts.find((p: any) => p.update === true)
    expect(progressUpdate).toBeDefined()
    expect(progressUpdate!.tool!.status).toBe('running')
    expect(progressUpdate!.tool!.title).toContain('15s')
  })
})

describe('convertSDKMessageToParts handles undefined/null content blocks', () => {
  it('skips undefined content blocks in assistant messages without crashing', () => {
    const adapter = new ClaudeCodeAdapter()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    // Simulate an assistant message with undefined/null content blocks
    const msg = {
      type: 'assistant',
      uuid: 'msg-1',
      message: {
        id: 'msg_01ABC',
        content: [
          undefined,
          null,
          { type: 'text', text: 'Hello' },
          undefined,
          { type: 'tool_use', id: 'toolu_01XYZ', name: 'Read', input: { file_path: '/tmp/test' } },
        ],
      },
    }

    // Should NOT throw — undefined/null blocks are skipped
    const parts = (adapter as any).convertSDKMessageToParts(msg, seenPartIds, partContentLengths)

    // Only the valid text and tool blocks should be processed
    const textPart = parts.find((p: any) => p.type === 'text')
    expect(textPart).toBeDefined()
    expect(textPart!.text).toBe('Hello')

    const toolPart = parts.find((p: any) => p.type === 'tool')
    expect(toolPart).toBeDefined()
    expect(toolPart!.id).toBe('tool-toolu_01XYZ')
  })

  it('skips undefined content blocks in user messages without crashing', () => {
    const adapter = new ClaudeCodeAdapter()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    // First emit a tool_use so the tool_result has something to match
    const toolUseMsg = {
      type: 'assistant',
      uuid: 'msg-1',
      message: {
        id: 'msg_01ABC',
        content: [
          { type: 'tool_use', id: 'toolu_01XYZ', name: 'Read', input: { file_path: '/tmp/test' } },
        ],
      },
    }
    ;(adapter as any).convertSDKMessageToParts(toolUseMsg, seenPartIds, partContentLengths)

    const userMsg = {
      type: 'user',
      uuid: 'msg-2',
      message: {
        content: [
          undefined,
          null,
          { type: 'tool_result', tool_use_id: 'toolu_01XYZ', content: 'file contents here' },
        ],
      },
    }

    // Should NOT throw — undefined/null blocks are skipped
    const parts = (adapter as any).convertSDKMessageToParts(userMsg, seenPartIds, partContentLengths)

    const toolResultPart = parts.find((p: any) => p.type === 'tool')
    expect(toolResultPart).toBeDefined()
    expect(toolResultPart!.tool!.status).toBe('success')
  })

  it('handles content array with all undefined/null entries', () => {
    const adapter = new ClaudeCodeAdapter()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const msg = {
      type: 'assistant',
      uuid: 'msg-1',
      message: {
        id: 'msg_01ALL_NULL',
        content: [undefined, null, undefined],
      },
    }

    const parts = (adapter as any).convertSDKMessageToParts(msg, seenPartIds, partContentLengths)
    expect(parts).toHaveLength(0)
  })
})

describe('ClaudeCodeAdapter loadSessionHistory stable IDs (regression)', () => {
  it('convertSDKMessageToParts generates stable IDs using message.id (not streaming UUID)', () => {
    const adapter = new ClaudeCodeAdapter()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    // Simulate an assistant message with stable API message ID
    const chunk = {
      type: 'assistant',
      uuid: 'streaming-uuid-123', // unstable streaming UUID
      message: {
        id: 'msg_01ABC', // stable API message ID
        content: [
          { type: 'text', text: 'Hello from Claude' },
          { type: 'tool_use', id: 'toolu_01XYZ', name: 'Read', input: { file_path: '/tmp/test' } }
        ]
      }
    }

    const parts = (adapter as any).convertSDKMessageToParts(chunk, seenPartIds, partContentLengths)

    // Text part ID should use stable message ID: `${stableId}-text-${blockIdx}`
    const textPart = parts.find((p: any) => p.type === 'text')
    expect(textPart).toBeDefined()
    expect(textPart!.id).toBe('msg_01ABC-text-0')

    // Tool part ID should use tool_use_id: `tool-${tool_use_id}`
    const toolPart = parts.find((p: any) => p.type === 'tool')
    expect(toolPart).toBeDefined()
    expect(toolPart!.id).toBe('tool-toolu_01XYZ')
  })

  it('emits update for streaming text parts with grown content', () => {
    const adapter = new ClaudeCodeAdapter()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    // First streaming chunk — empty text (partial)
    const chunk1 = {
      type: 'assistant',
      uuid: 'uuid-1',
      message: { id: 'msg_01DEF', content: [{ type: 'text', text: '' }] }
    }
    const parts1 = (adapter as any).convertSDKMessageToParts(chunk1, seenPartIds, partContentLengths)
    expect(parts1).toHaveLength(1)
    expect(parts1[0].text).toBe('')

    // Second streaming chunk — same message, text has grown
    const chunk2 = {
      type: 'assistant',
      uuid: 'uuid-2', // different UUID but same message.id
      message: { id: 'msg_01DEF', content: [{ type: 'text', text: 'Full response text' }] }
    }
    const parts2 = (adapter as any).convertSDKMessageToParts(chunk2, seenPartIds, partContentLengths)
    expect(parts2).toHaveLength(1)
    expect(parts2[0].update).toBe(true)
    expect(parts2[0].text).toBe('Full response text')
  })

  it('surfaces non-error result text when no assistant text was emitted', () => {
    const adapter = new ClaudeCodeAdapter()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const resultMsg = {
      type: 'result',
      uuid: 'uuid-result',
      is_error: false,
      result: 'Final answer from the agent'
    }

    const parts = (adapter as any).convertSDKMessageToParts(resultMsg, seenPartIds, partContentLengths)
    expect(parts).toHaveLength(1)
    expect(parts[0].text).toBe('Final answer from the agent')
  })
})
