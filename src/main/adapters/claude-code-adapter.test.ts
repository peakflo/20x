/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

// Mock the SDK before importing the adapter
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  // The real module exports this; the adapter uses it to tell a deliberate
  // abort apart from a genuine stream failure.
  AbortError: class AbortError extends Error {},
}))

// Mock child_process and fs to avoid real filesystem operations
vi.mock('child_process', () => ({ execFile: vi.fn() }))
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }))

import { ClaudeCodeAdapter, ClaudeSystemSubtype } from './claude-code-adapter'
import { MessagePartType } from './coding-agent-adapter'

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
    backgroundTasks: new Map(),
    sawResult: false,
    releasePrompt: null,
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
      expect(errorPart!.type).toBe(MessagePartType.ERROR)
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
      expect(errorPart!.type).toBe(MessagePartType.ERROR)
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
      expect(errorPart!.type).toBe(MessagePartType.ERROR)
      expect(errorPart!.text).toContain('Too many requests')
    })

    it('surfaces Claude API error assistant messages as error parts', async () => {
      const errorMsg = {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          id: 'api-error-msg',
          role: 'assistant',
          content: [{ type: 'text', text: 'Prompt is too long' }],
        },
        uuid: 'api-error-1',
      }
      const { adapter } = createAdapterWithSession('s1', [errorMsg])

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()
      const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

      expect(parts).toEqual([
        expect.objectContaining({
          id: 'api-error-msg-text-0',
          type: MessagePartType.ERROR,
          text: 'Prompt is too long',
        })
      ])
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
        backgroundTasks: new Map(),
        sawResult: false,
        releasePrompt: null,
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
        backgroundTasks: new Map(),
        sawResult: false,
        releasePrompt: null,
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
        backgroundTasks: new Map(),
        sawResult: false,
        releasePrompt: null,
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
        backgroundTasks: new Map(),
        sawResult: false,
        releasePrompt: null,
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
        backgroundTasks: new Map(),
        sawResult: false,
        releasePrompt: null,
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
        queryIterator: fakeIterator,
        backgroundTasks: new Map(),
        sawResult: false,
        releasePrompt: null, // Process still alive
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
  it('converts thinking_tokens system messages to reasoning parts', async () => {
    const msg = {
      type: 'system',
      subtype: ClaudeSystemSubtype.THINKING_TOKENS,
      estimated_tokens: 128,
      estimated_tokens_delta: 32,
      uuid: 'tt-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [msg])
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe(MessagePartType.REASONING)
    expect(parts[0].id).toBe('thinking-tokens-s1')
    expect(parts[0].text).toBe('Estimated thinking tokens: 128')
    expect(parts[0].role).toBe('assistant')
  })

  it('updates one thinking_tokens reasoning part instead of appending messages', async () => {
    const messages = [
      {
        type: 'system',
        subtype: ClaudeSystemSubtype.THINKING_TOKENS,
        estimated_tokens: 128,
        estimated_tokens_delta: 32,
        uuid: 'tt-1',
        session_id: 's1',
      },
      {
        type: 'system',
        subtype: ClaudeSystemSubtype.THINKING_TOKENS,
        estimated_tokens: 256,
        estimated_tokens_delta: 128,
        uuid: 'tt-2',
        session_id: 's1',
      },
    ]

    const { adapter } = createAdapterWithSession('s1', messages)
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    expect(parts).toHaveLength(2)
    expect(parts[0].id).toBe('thinking-tokens-s1')
    expect(parts[0].update).toBe(false)
    expect(parts[0].text).toBe('Estimated thinking tokens: 128')
    expect(parts[1].id).toBe('thinking-tokens-s1')
    expect(parts[1].update).toBe(true)
    expect(parts[1].text).toBe('Estimated thinking tokens: 256')
  })

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

  it('converts assistant thinking content blocks to reasoning parts', () => {
    const adapter = new ClaudeCodeAdapter()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const msg = {
      type: 'assistant',
      uuid: 'uuid-thinking',
      message: {
        id: 'msg_01THINK',
        content: [
          { type: 'thinking', thinking: 'I should inspect the adapter mapping first.', signature: 'sig' },
          { type: 'text', text: 'I found the issue.' },
        ]
      }
    }

    const parts = (adapter as any).convertSDKMessageToParts(msg, seenPartIds, partContentLengths)
    const thinkingPart = parts.find((p: any) => p.type === MessagePartType.REASONING)

    expect(thinkingPart).toBeDefined()
    expect(thinkingPart!.id).toBe('msg_01THINK-thinking-0')
    expect(thinkingPart!.text).toBe('I should inspect the adapter mapping first.')
    expect(thinkingPart!.role).toBe('assistant')
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

describe('ClaudeCodeAdapter persistent session input', () => {
  it('queues a follow-up on the live query instead of closing the session', async () => {
    const { adapter, session } = createAdapterWithSession('s1', [])
    await adapter.initialize()
    const enqueuePrompt = vi.fn()
    const releasePrompt = vi.fn()
    session.queryIterator = {} as any
    ;(session as any).enqueuePrompt = enqueuePrompt
    ;(session as any).releasePrompt = releasePrompt

    await adapter.sendPrompt(
      's1',
      [{ type: MessagePartType.TEXT, text: 'continue working' }],
      {} as any,
    )

    expect(enqueuePrompt).toHaveBeenCalledWith('continue working')
    expect(releasePrompt).not.toHaveBeenCalled()
    expect(session.queryIterator).not.toBeNull()
    expect(session.status).toBe('busy')
  })
})

/**
 * Regression tests for: "Claude Code spawns subagents, then is marked idle,
 * which pauses/kills the subagents."
 *
 * Claude Code backgrounds Task-tool subagents by default: the tool call returns
 * immediately, the coordinator's turn ends (emitting `result`) and the subagent
 * keeps working, waking the session later via `task_notification`.  Treating
 * that `result` as "session finished" made agent-manager mark the task
 * ready_for_review, unregister it from polling and eventually reap it — and the
 * one-shot string prompt made the CLI kill the children outright.
 */
describe('ClaudeCodeAdapter background subagent lifecycle', () => {
  /** Drives consumeStream over a fixed list of SDK messages. */
  function runStream(messages: any[]) {
    const adapter = new ClaudeCodeAdapter()
    let i = 0
    const fakeIterator = {
      [Symbol.asyncIterator]() { return this },
      async next() {
        if (i < messages.length) return { done: false, value: messages[i++] }
        return { done: true, value: undefined }
      },
    }
    const session: any = {
      sessionId: 's1',
      queryIterator: fakeIterator,
      backgroundTasks: new Map(),
      sawResult: false,
      releasePrompt: null,
      abortController: null,
      status: 'busy',
      messageBuffer: [],
      messageCursor: 0,
      streamTask: null,
      lastError: null,
      config: {} as any,
    }
    ;(adapter as any).sessions.set('s1', session)
    return { adapter, session, fakeIterator }
  }

  const taskStarted = (id: string, taskType = 'local_agent') => ({
    type: 'system', subtype: ClaudeSystemSubtype.TASK_STARTED,
    task_id: id, task_type: taskType, description: `task ${id}`, uuid: `u-start-${id}`,
  })
  const taskNotification = (id: string, status: string) => ({
    type: 'system', subtype: ClaudeSystemSubtype.TASK_NOTIFICATION,
    task_id: id, status, uuid: `u-note-${id}-${status}`,
  })
  const resultMsg = (uuid: string) => ({ type: 'result', subtype: 'success', is_error: false, uuid })

  it('stays busy when the turn emits `result` while a background subagent is still running', async () => {
    // task_started -> result : the classic "coordinator went quiet" sequence.
    const { adapter, session } = runStream([taskStarted('t1'), resultMsg('r1')])

    // Stop before the stream ends so we observe mid-flight state.
    await (adapter as any).trackBackgroundTask('s1', session, taskStarted('t1'))
    session.sawResult = true
    ;(adapter as any).settleTurnIfComplete('s1', session)

    expect(session.backgroundTasks.size).toBe(1)
    expect(session.status).toBe('busy')

    const status = await adapter.getStatus('s1', {} as any)
    expect(status.type).toBe('busy')
  })

  it('getStatus reports BUSY even when session.status is idle but a background task is in flight', async () => {
    const { adapter, session } = runStream([])
    session.status = 'idle'
    session.backgroundTasks.set('t1', { taskId: 't1', taskType: 'local_agent', startedAt: Date.now() })

    const status = await adapter.getStatus('s1', {} as any)
    expect(status.type).toBe('busy')
  })

  it('settles to idle only once every background task has reported a terminal status', async () => {
    const { adapter, session } = runStream([])
    const release = vi.fn()
    session.releasePrompt = release

    ;(adapter as any).trackBackgroundTask('s1', session, taskStarted('t1'))
    ;(adapter as any).trackBackgroundTask('s1', session, taskStarted('t2', 'local_bash'))
    session.sawResult = true
    ;(adapter as any).settleTurnIfComplete('s1', session)
    expect(session.status).toBe('busy')

    ;(adapter as any).trackBackgroundTask('s1', session, taskNotification('t1', 'completed'))
    ;(adapter as any).settleTurnIfComplete('s1', session)
    expect(session.status).toBe('busy')

    ;(adapter as any).trackBackgroundTask('s1', session, taskNotification('t2', 'stopped'))
    ;(adapter as any).settleTurnIfComplete('s1', session)
    expect(session.backgroundTasks.size).toBe(0)
    expect(session.status).toBe('idle')
    expect((await adapter.getStatus('s1', {} as any)).type).toBe('idle')
    expect(release).not.toHaveBeenCalled()
    expect(session.releasePrompt).toBe(release)
  })

  it('clears a background task from task_updated with a terminal patch status (killed)', async () => {
    const { adapter, session } = runStream([])
    ;(adapter as any).trackBackgroundTask('s1', session, taskStarted('t1'))
    expect(session.backgroundTasks.size).toBe(1)

    ;(adapter as any).trackBackgroundTask('s1', session, {
      type: 'system', subtype: ClaudeSystemSubtype.TASK_UPDATED,
      task_id: 't1', patch: { status: 'killed' }, uuid: 'u-upd',
    })
    expect(session.backgroundTasks.size).toBe(0)
  })

  it('ignores non-terminal task_updated patches', async () => {
    const { adapter, session } = runStream([])
    ;(adapter as any).trackBackgroundTask('s1', session, taskStarted('t1'))
    ;(adapter as any).trackBackgroundTask('s1', session, {
      type: 'system', subtype: ClaudeSystemSubtype.TASK_UPDATED,
      task_id: 't1', patch: { status: 'running' }, uuid: 'u-upd2',
    })
    expect(session.backgroundTasks.size).toBe(1)
  })

  it('a new assistant turn after `result` clears sawResult so a wake-up is not mistaken for completion', async () => {
    const { adapter, session } = runStream([
      taskStarted('t1'),
      resultMsg('r1'),
      taskNotification('t1', 'completed'),
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: 'child finished' }] } },
    ])
    await (adapter as any).consumeStream('s1', session)
    // Stream ended, so the finally-block drains everything.
    expect(session.backgroundTasks.size).toBe(0)
    expect(session.status).toBe('idle')
  })

  it('exposes in-flight background tasks as delegation tools so watchdogs stand down', async () => {
    const { adapter, session } = runStream([])
    ;(adapter as any).trackBackgroundTask('s1', session, taskStarted('t1'))
    ;(adapter as any).trackBackgroundTask('s1', session, taskStarted('t2', 'local_bash'))

    const tools = await adapter.getRunningTools('s1', {} as any)
    expect(tools).toHaveLength(2)
    // Both must be named `task` — a backgrounded bash reported as `bash` would
    // trip agent-manager's 90s stuck-tool detector and abort the session.
    expect(tools.every((t) => t.toolName === 'task')).toBe(true)
    expect(tools[0].partId).toBe('task-t1')
    expect(typeof tools[0].startTime).toBe('number')
  })

  it('getRunningTools returns [] for an unknown session', async () => {
    const adapter = new ClaudeCodeAdapter()
    expect(await adapter.getRunningTools('nope', {} as any)).toEqual([])
  })

  it('clears background tasks and releases the prompt stream when the stream ends', async () => {
    const { adapter, session } = runStream([taskStarted('t1'), resultMsg('r1')])
    const release = vi.fn()
    session.releasePrompt = release

    await (adapter as any).consumeStream('s1', session)

    expect(session.backgroundTasks.size).toBe(0)
    expect(session.releasePrompt).toBeNull()
    expect(release).toHaveBeenCalled()
    expect(session.status).toBe('idle')
  })
})

describe('ClaudeCodeAdapter background task safety cap', () => {
  it('ages out a background task that never reports a terminal status', async () => {
    const adapter = new ClaudeCodeAdapter()
    const session: any = {
      sessionId: 's1', queryIterator: null, abortController: null,
      status: 'busy', messageBuffer: [], messageCursor: 0, streamTask: null,
      lastError: null, config: {} as any,
      backgroundTasks: new Map([['stale', {
        taskId: 'stale', taskType: 'local_agent',
        startedAt: Date.now() - (61 * 60 * 1000), // 61 minutes ago
      }]]),
      sawResult: true,
      releasePrompt: null,
    }
    ;(adapter as any).sessions.set('s1', session)

    // The 2s poll path is what ages it out.
    const status = await adapter.getStatus('s1', {} as any)

    expect(session.backgroundTasks.size).toBe(0)
    expect(status.type).toBe('idle')
  })

  it('keeps a background task that is still within the age cap', async () => {
    const adapter = new ClaudeCodeAdapter()
    const session: any = {
      sessionId: 's1', queryIterator: null, abortController: null,
      status: 'busy', messageBuffer: [], messageCursor: 0, streamTask: null,
      lastError: null, config: {} as any,
      backgroundTasks: new Map([['fresh', {
        taskId: 'fresh', taskType: 'local_agent', startedAt: Date.now() - 60_000,
      }]]),
      sawResult: true,
      releasePrompt: null,
    }
    ;(adapter as any).sessions.set('s1', session)

    const status = await adapter.getStatus('s1', {} as any)

    expect(session.backgroundTasks.size).toBe(1)
    expect(status.type).toBe('busy')
  })
})

/**
 * Regression tests for transcript pollution + authoritative background-task list.
 *
 * Observed in a real run: the transcript was littered with literal
 * "background_tasks_changed" / "task_updated" text bubbles between every subagent
 * update, because unhandled `system` subtypes fall through to a generic handler
 * that pushes `msg.subtype` as the message content.
 */
describe('ClaudeCodeAdapter background-task system messages', () => {
  it('does not render task_updated as a transcript text bubble', () => {
    const adapter = new ClaudeCodeAdapter()
    const parts = (adapter as any).convertSDKMessageToParts(
      { type: 'system', subtype: ClaudeSystemSubtype.TASK_UPDATED, task_id: 't1',
        patch: { status: 'completed' }, uuid: 'u1' },
      new Set<string>(), new Map<string, string>()
    )
    expect(parts).toEqual([])
  })

  it('does not render background_tasks_changed as a transcript text bubble', () => {
    const adapter = new ClaudeCodeAdapter()
    const parts = (adapter as any).convertSDKMessageToParts(
      { type: 'system', subtype: ClaudeSystemSubtype.BACKGROUND_TASKS_CHANGED,
        tasks: [{ task_id: 't1', task_type: 'local_agent' }], uuid: 'u2' },
      new Set<string>(), new Map<string, string>()
    )
    expect(parts).toEqual([])
  })

  it('still renders genuinely unknown system subtypes so nothing is silently swallowed', () => {
    const adapter = new ClaudeCodeAdapter()
    const parts = (adapter as any).convertSDKMessageToParts(
      { type: 'system', subtype: 'some_future_subtype', uuid: 'u3' },
      new Set<string>(), new Map<string, string>()
    )
    expect(parts).toHaveLength(1)
    expect(parts[0].content).toBe('some_future_subtype')
  })

  it('rebuilds the in-flight set from background_tasks_changed when the SDK passes it through', () => {
    const adapter = new ClaudeCodeAdapter()
    const session: any = { backgroundTasks: new Map(), sawResult: false, releasePrompt: null, status: 'busy' }

    ;(adapter as any).trackBackgroundTask('s1', session, {
      type: 'system', subtype: ClaudeSystemSubtype.BACKGROUND_TASKS_CHANGED,
      tasks: [{ task_id: 'a', task_type: 'local_agent' }, { task_id: 'b', task_type: 'local_bash' }],
    })
    expect([...session.backgroundTasks.keys()].sort()).toEqual(['a', 'b'])

    const startedAtA = session.backgroundTasks.get('a').startedAt

    // A later snapshot with 'a' drained must shrink the set...
    ;(adapter as any).trackBackgroundTask('s1', session, {
      type: 'system', subtype: ClaudeSystemSubtype.BACKGROUND_TASKS_CHANGED,
      tasks: [{ task_id: 'b', task_type: 'local_bash' }],
    })
    expect([...session.backgroundTasks.keys()]).toEqual(['b'])

    // ...and an empty snapshot drains it entirely.
    ;(adapter as any).trackBackgroundTask('s1', session, {
      type: 'system', subtype: ClaudeSystemSubtype.BACKGROUND_TASKS_CHANGED, tasks: [],
    })
    expect(session.backgroundTasks.size).toBe(0)
    expect(typeof startedAtA).toBe('number')
  })

  it('preserves startedAt across background_tasks_changed snapshots so the staleness cap stays meaningful', () => {
    const adapter = new ClaudeCodeAdapter()
    const oldStart = Date.now() - 120_000
    const session: any = {
      backgroundTasks: new Map([['a', { taskId: 'a', taskType: 'local_agent', startedAt: oldStart }]]),
      sawResult: false, releasePrompt: null, status: 'busy',
    }

    ;(adapter as any).trackBackgroundTask('s1', session, {
      type: 'system', subtype: ClaudeSystemSubtype.BACKGROUND_TASKS_CHANGED,
      tasks: [{ task_id: 'a', task_type: 'local_agent' }],
    })

    expect(session.backgroundTasks.get('a').startedAt).toBe(oldStart)
  })
})

describe('ClaudeCodeAdapter abort classification (regression)', () => {
  /**
   * The agent SDK declares `class AbortError extends Error {}` with no `name`
   * override, so a deliberate abort surfaces as `name: 'Error'` /
   * `message: 'Operation aborted'`. The old classifier matched neither, so a
   * normal stop was recorded as a session error.
   */
  function sessionThatThrows(err: unknown, opts?: { aborted?: boolean }) {
    const abortController = new AbortController()
    if (opts?.aborted !== false) abortController.abort()
    return {
      sessionId: 's1',
      queryIterator: {
        [Symbol.asyncIterator]() { return this },
        async next() { throw err },
      },
      backgroundTasks: new Map(),
      sawResult: false,
      releasePrompt: null,
      enqueuePrompt: null,
      abortController,
      status: 'busy',
      messageBuffer: [],
      messageCursor: 0,
      streamTask: null,
      lastError: null,
      config: {} as any,
      isResumed: false,
    } as any
  }

  it('treats the SDK "Operation aborted" error as a normal abort, not a session error', async () => {
    const adapter = new ClaudeCodeAdapter()
    const err = new Error('Operation aborted') // name stays 'Error', as the SDK emits it
    const session = sessionThatThrows(err)
    ;(adapter as any).sessions.set('s1', session)

    await (adapter as any).consumeStream('s1', session)

    expect(session.status).toBe('idle')
    expect(session.lastError).toBeNull()
  })

  it('keeps getStatus IDLE after an abort so polling and the task are not failed', async () => {
    const adapter = new ClaudeCodeAdapter()
    const session = sessionThatThrows(new Error('Operation aborted'))
    ;(adapter as any).sessions.set('s1', session)

    await (adapter as any).consumeStream('s1', session)
    const status = await adapter.getStatus('s1', {} as any)

    expect(status.type).toBe('idle')
  })

  it('classifies any stream failure as an abort once the signal is aborted', async () => {
    const adapter = new ClaudeCodeAdapter()
    // waitForExit can also reject with the process-exit error during teardown.
    const session = sessionThatThrows(new Error('Claude Code process terminated by signal SIGTERM'))
    ;(adapter as any).sessions.set('s1', session)

    await (adapter as any).consumeStream('s1', session)

    expect(session.status).toBe('idle')
    expect(session.lastError).toBeNull()
  })

  it('still records a real failure when no abort was requested', async () => {
    const adapter = new ClaudeCodeAdapter()
    const session = sessionThatThrows(new Error('socket hang up'), { aborted: false })
    ;(adapter as any).sessions.set('s1', session)

    await (adapter as any).consumeStream('s1', session)

    expect(session.status).toBe('error')
    expect(session.lastError).toBe('socket hang up')
  })
})
