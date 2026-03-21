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

    it('does NOT reset queryIterator when stream completes normally (idle)', async () => {
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

      // queryIterator should remain set — process is alive for continue
      expect(session.queryIterator).toBe(fakeIterator)
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

describe('ClaudeCodeAdapter tool_progress handling', () => {
  it('updates existing tool part with elapsed time', async () => {
    // Seed a tool_use message first so seenPartIds has the tool entry
    const toolUseMsg = {
      type: 'assistant',
      uuid: 'msg-1',
      message: {
        id: 'api-msg-1',
        content: [{ type: 'tool_use', name: 'Bash', id: 'tu-123', input: { command: 'ls' } }],
      },
    }
    const progressMsg = {
      type: 'tool_progress',
      tool_use_id: 'tu-123',
      tool_name: 'Bash',
      parent_tool_use_id: null,
      elapsed_time_seconds: 5,
      uuid: 'prog-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [toolUseMsg, progressMsg])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    // Should have the initial tool part + an update with elapsed time
    const toolPart = parts.find((p: any) => p.id === 'tool-tu-123' && p.update)
    expect(toolPart).toBeDefined()
    expect(toolPart!.tool.status).toBe('running')
    expect(toolPart!.tool.title).toContain('5s')
  })

  it('ignores tool_progress when tool has not been seen yet', async () => {
    const progressMsg = {
      type: 'tool_progress',
      tool_use_id: 'tu-unknown',
      tool_name: 'Bash',
      parent_tool_use_id: null,
      elapsed_time_seconds: 3,
      uuid: 'prog-2',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [progressMsg])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    // No tool parts should be emitted
    const toolParts = parts.filter((p: any) => p.id?.startsWith('tool-'))
    expect(toolParts).toHaveLength(0)
  })

  it('formats elapsed time with minutes for long-running tools', async () => {
    const toolUseMsg = {
      type: 'assistant',
      uuid: 'msg-2',
      message: {
        id: 'api-msg-2',
        content: [{ type: 'tool_use', name: 'Agent', id: 'tu-456', input: { description: 'test' } }],
      },
    }
    const progressMsg = {
      type: 'tool_progress',
      tool_use_id: 'tu-456',
      tool_name: 'Agent',
      parent_tool_use_id: null,
      elapsed_time_seconds: 125,
      uuid: 'prog-3',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [toolUseMsg, progressMsg])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    const updatePart = parts.find((p: any) => p.id === 'tool-tu-456' && p.update)
    expect(updatePart).toBeDefined()
    expect(updatePart!.tool.title).toContain('2m')
    expect(updatePart!.tool.title).toContain('5s')
  })
})

describe('ClaudeCodeAdapter task_notification handling', () => {
  it('renders task_notification as task_progress part type with completed status', async () => {
    const taskNotif = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-1',
      status: 'completed',
      output_file: '/tmp/out.json',
      summary: 'All tests passed successfully',
      uuid: 'tn-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [taskNotif])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    const notifPart = parts.find((p: any) => p.type === 'task_progress')
    expect(notifPart).toBeDefined()
    expect(notifPart!.content).toBe('All tests passed successfully')
    expect(notifPart!.taskProgress.status).toBe('completed')
    expect(notifPart!.taskProgress.taskId).toBe('task-1')
  })

  it('renders failed task_notification with failed status', async () => {
    const taskNotif = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-2',
      status: 'failed',
      output_file: '/tmp/err.json',
      summary: 'Build failed with exit code 1',
      uuid: 'tn-2',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [taskNotif])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    const notifPart = parts.find((p: any) => p.type === 'task_progress')
    expect(notifPart).toBeDefined()
    expect(notifPart!.taskProgress.status).toBe('failed')
  })
})

describe('ClaudeCodeAdapter task_started handling', () => {
  it('renders task_started as task_progress part with started status', async () => {
    const taskStarted = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-3',
      description: 'Running unit tests',
      uuid: 'ts-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [taskStarted])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    const startPart = parts.find((p: any) => p.type === 'task_progress')
    expect(startPart).toBeDefined()
    expect(startPart!.taskProgress.status).toBe('started')
    expect(startPart!.taskProgress.description).toBe('Running unit tests')
  })
})

describe('ClaudeCodeAdapter task_progress (subagent) handling', () => {
  it('updates existing task with running status and usage info', async () => {
    const taskStarted = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-4',
      description: 'Investigating bug',
      uuid: 'ts-2',
      session_id: 's1',
    }
    const taskProgress = {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task-4',
      description: 'Investigating bug',
      last_tool_name: 'Grep',
      usage: { total_tokens: 5000, tool_uses: 3, duration_ms: 12000 },
      uuid: 'tp-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [taskStarted, taskProgress])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    const progressPart = parts.find((p: any) => p.type === 'task_progress' && p.update)
    expect(progressPart).toBeDefined()
    expect(progressPart!.taskProgress.status).toBe('running')
    expect(progressPart!.taskProgress.lastToolName).toBe('Grep')
    expect(progressPart!.taskProgress.usage).toBeDefined()
  })
})

describe('ClaudeCodeAdapter status event handling', () => {
  it('renders compacting status as system-status part', async () => {
    const statusMsg = {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: 'st-1',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [statusMsg])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    const statusPart = parts.find((p: any) => p.type === 'system-status')
    expect(statusPart).toBeDefined()
    expect(statusPart!.content).toContain('Compacting')
    expect(statusPart!.role).toBe('system')
  })

  it('skips null status events', async () => {
    const statusMsg = {
      type: 'system',
      subtype: 'status',
      status: null,
      uuid: 'st-2',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [statusMsg])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    // No system-status parts should be emitted
    expect(parts.filter((p: any) => p.type === 'system-status')).toHaveLength(0)
  })

  it('does not render status events as plain text', async () => {
    const statusMsg = {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: 'st-3',
      session_id: 's1',
    }

    const { adapter } = createAdapterWithSession('s1', [statusMsg])

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()
    const parts = await adapter.pollMessages('s1', new Set(), seenPartIds, partContentLengths, {} as any)

    // Should not have a plain text part with "status" content
    const plainTextParts = parts.filter((p: any) => p.type === 'text' && p.content === 'status')
    expect(plainTextParts).toHaveLength(0)
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
    expect(progressUpdate.tool.status).toBe('running')
    expect(progressUpdate.tool.title).toContain('15s')
  })
})
