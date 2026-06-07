import { describe, it, expect } from 'vitest'
import { serializeTranscriptForDebug } from './serialize-transcript-debug'
import type { RawTranscriptMessage } from './serialize-transcript-debug'
import { SessionStatus } from '@/stores/agent-store'
import type { AgentMessage } from '@/stores/agent-store'

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Hello world',
    timestamp: new Date('2025-01-15T10:30:00Z'),
    ...overrides
  }
}

describe('serializeTranscriptForDebug', () => {
  it('should include header with session metadata', () => {
    const result = serializeTranscriptForDebug([], {
      sessionId: 'sess-123',
      taskId: 'task-456',
      agentId: 'agent-789',
      status: SessionStatus.WORKING,
      messageCount: 0
    })

    expect(result).toContain('=== Agent Transcript Debug ===')
    expect(result).toContain('Session: sess-123')
    expect(result).toContain('Task: task-456')
    expect(result).toContain('Agent: agent-789')
    expect(result).toContain('Status: working')
    expect(result).toContain('Total Messages: 0')
    expect(result).toContain('=== End Debug ===')
  })

  it('should include UI Messages section label', () => {
    const messages = [makeMessage({ content: 'Test response' })]
    const result = serializeTranscriptForDebug(messages, {
      status: SessionStatus.IDLE,
      messageCount: 1
    })

    expect(result).toContain('--- UI Messages (processed) ---')
    expect(result).toContain('assistant')
    expect(result).toContain('Test response')
  })

  it('should serialize tool call messages', () => {
    const messages = [makeMessage({
      partType: 'tool',
      content: '',
      tool: {
        name: 'Bash',
        status: 'completed',
        title: 'Run tests',
        input: 'npm test',
        output: 'All tests passed'
      }
    })]
    const result = serializeTranscriptForDebug(messages, {
      status: SessionStatus.IDLE,
      messageCount: 1
    })

    expect(result).toContain('Bash')
    expect(result).toContain('[completed]')
    expect(result).toContain('npm test')
    expect(result).toContain('All tests passed')
  })

  it('should serialize error messages', () => {
    const messages = [makeMessage({
      partType: 'tool',
      content: '',
      tool: {
        name: 'Edit',
        status: 'error',
        error: 'File not found'
      }
    })]
    const result = serializeTranscriptForDebug(messages, {
      status: SessionStatus.ERROR,
      messageCount: 1
    })

    expect(result).toContain('error: File not found')
  })

  it('should truncate long tool content', () => {
    const longContent = 'x'.repeat(5000)
    const messages = [makeMessage({
      partType: 'tool',
      content: '',
      tool: {
        name: 'Read',
        status: 'completed',
        output: longContent
      }
    })]
    const result = serializeTranscriptForDebug(messages, {
      status: SessionStatus.IDLE,
      messageCount: 1
    })

    expect(result).toContain('truncated')
    expect(result.length).toBeLessThan(longContent.length)
  })

  it('should only include last 50 UI messages', () => {
    const messages = Array.from({ length: 80 }, (_, i) =>
      makeMessage({ id: `msg-${i}`, content: `Message ${i}` })
    )
    const result = serializeTranscriptForDebug(messages, {
      status: SessionStatus.IDLE,
      messageCount: 80
    })

    expect(result).toContain('30 earlier messages omitted')
    expect(result).toContain('Message 30')
    expect(result).toContain('Message 79')
  })

  it('should include step metadata', () => {
    const messages = [makeMessage({
      stepMeta: {
        durationMs: 1234,
        tokens: { input: 100, output: 50, cache: 25 }
      }
    })]
    const result = serializeTranscriptForDebug(messages, {
      status: SessionStatus.IDLE,
      messageCount: 1
    })

    expect(result).toContain('1.2s')
    expect(result).toContain('in:100')
    expect(result).toContain('out:50')
    expect(result).toContain('cache:25')
  })

  it('should include task progress data', () => {
    const messages = [makeMessage({
      partType: 'task_progress',
      content: '',
      taskProgress: {
        taskId: 'sub-1',
        status: 'completed',
        description: 'Running tests',
        summary: 'All tests passed',
        usage: { total_tokens: 5000, tool_uses: 12, duration_ms: 30000 }
      }
    })]
    const result = serializeTranscriptForDebug(messages, {
      status: SessionStatus.IDLE,
      messageCount: 1
    })

    expect(result).toContain('completed')
    expect(result).toContain('Running tests')
    expect(result).toContain('5000 tokens')
    expect(result).toContain('12 tools')
  })

  it('should handle null sessionId gracefully', () => {
    const result = serializeTranscriptForDebug([], {
      sessionId: null,
      status: SessionStatus.IDLE,
      messageCount: 0
    })

    expect(result).toContain('Session: (none)')
  })

  // ── Raw transcript tests ──

  it('should include raw transcript section when provided', () => {
    const rawTranscript: RawTranscriptMessage[] = [
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'Let me check the code.' },
          { type: 'tool', tool: { name: 'Bash', status: 'completed', input: 'ls -la', output: 'file1.ts\nfile2.ts' } }
        ]
      }
    ]
    const result = serializeTranscriptForDebug([], {
      status: SessionStatus.IDLE,
      messageCount: 0
    }, rawTranscript)

    expect(result).toContain('--- Raw Agent Transcript (1 messages) ---')
    expect(result).toContain('assistant')
    expect(result).toContain('[text]')
    expect(result).toContain('Let me check the code.')
    expect(result).toContain('[tool]')
    expect(result).toContain('tool: Bash [completed]')
    expect(result).toContain('input: ls -la')
    expect(result).toContain('output: file1.ts')
  })

  it('should include reasoning/thinking blocks from raw transcript', () => {
    const rawTranscript: RawTranscriptMessage[] = [
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'I need to think about this carefully...' },
          { type: 'text', content: 'Here is my answer.' }
        ]
      }
    ]
    const result = serializeTranscriptForDebug([], {
      status: SessionStatus.IDLE,
      messageCount: 0
    }, rawTranscript)

    expect(result).toContain('[reasoning]')
    expect(result).toContain('I need to think about this carefully...')
    expect(result).toContain('[text]')
    expect(result).toContain('Here is my answer.')
  })

  it('should omit raw transcript section when empty', () => {
    const result = serializeTranscriptForDebug([], {
      status: SessionStatus.IDLE,
      messageCount: 0
    }, [])

    expect(result).not.toContain('Raw Agent Transcript')
  })

  it('should omit raw transcript section when undefined', () => {
    const result = serializeTranscriptForDebug([], {
      status: SessionStatus.IDLE,
      messageCount: 0
    })

    expect(result).not.toContain('Raw Agent Transcript')
  })

  it('should include tool errors from raw transcript', () => {
    const rawTranscript: RawTranscriptMessage[] = [
      {
        role: 'assistant',
        parts: [
          { type: 'tool', tool: { name: 'Edit', status: 'error', error: 'Permission denied: /etc/hosts' } }
        ]
      }
    ]
    const result = serializeTranscriptForDebug([], {
      status: SessionStatus.IDLE,
      messageCount: 0
    }, rawTranscript)

    expect(result).toContain('error: Permission denied: /etc/hosts')
  })
})
