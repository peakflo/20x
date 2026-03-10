/**
 * Tests for ACP Adapter turn-based message ID detection
 */

import { ChildProcess } from 'child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AcpAdapter } from './acp-adapter'
import { SessionStatusType, MessagePartType, MessagePart } from './coding-agent-adapter'

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: {
      on: vi.fn()
    },
    stderr: {
      on: vi.fn()
    },
    stdin: {
      write: vi.fn()
    },
    on: vi.fn(),
    kill: vi.fn()
  }))
}))

// Type for accessing private members of AcpAdapter in tests
interface AcpAdapterPrivate {
  sessions: Map<string, AcpSessionForTest>
  convertAcpEventToMessageParts(
    event: unknown,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session?: AcpSessionForTest
  ): MessagePart[]
}

// Minimal session type for tests (mirrors private AcpSession)
interface AcpSessionForTest {
  sessionId: string
  acpSessionId: string | null
  process: ChildProcess
  stdoutBuffer: string
  status: SessionStatusType
  messageBuffer: unknown[]
  permanentMessages: unknown[]
  pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>
  nextRequestId: number
  pendingApproval: unknown | null
  promptRequestId: number | null
  responseCounter: number
  lastChunkTime: number | null
  currentTurnId: number
  activeTurnId: number | null
  toolCallMetadata: Map<string, { name: string; input: string }>
}

/** Cast adapter to access private members for testing */
function adapterPrivate(adapter: AcpAdapter): AcpAdapterPrivate {
  return adapter as unknown as AcpAdapterPrivate
}

/** Create a mock session for testing */
function createMockSession(sessionId: string): AcpSessionForTest {
  return {
    sessionId,
    acpSessionId: null,
    process: {} as unknown as ChildProcess,
    stdoutBuffer: '',
    status: SessionStatusType.IDLE,
    messageBuffer: [],
    permanentMessages: [],
    pendingRequests: new Map(),
    nextRequestId: 1,
    pendingApproval: null,
    promptRequestId: null,
    responseCounter: 0,
    lastChunkTime: null,
    currentTurnId: 0,
    activeTurnId: null,
    toolCallMetadata: new Map()
  }
}

describe('AcpAdapter - Turn Detection', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter('codex')

    // Fast-forward time for time-based tests
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('Time-based turn detection', () => {
    it('should use same turn ID for messages arriving within 2 seconds', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      // Get access to the private session
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      // Simulate first chunk
      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' }
          }
        }
      }

      // Process first chunk
      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1) // First turn
      expect(parts1[0].id).toBe('agent-response-1')

      // Advance time by 1 second (within threshold)
      vi.advanceTimersByTime(1000)

      // Simulate second chunk
      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' World' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1) // Still turn 1
      expect(parts2[0].id).toBe('agent-response-1') // Same ID
    })

    it('should increment turn ID for messages arriving after 2+ seconds', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      // First chunk
      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First message' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1)
      expect(parts1[0].id).toBe('agent-response-1')

      // Advance time by 3 seconds (beyond threshold)
      vi.advanceTimersByTime(3000)

      // Second chunk (new turn)
      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Second message' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(2) // New turn
      expect(parts2[0].id).toBe('agent-response-2') // Different ID
    })

    it('should keep same turn during long gaps when prompt-scoped turn is active', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      session.currentTurnId = 1
      session.activeTurnId = 1

      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Long response part 1' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts1[0].id).toBe('agent-response-1')

      // Simulate a long pause between chunks (stream stall/network jitter)
      vi.advanceTimersByTime(3000)

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' and part 2' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(session.currentTurnId).toBe(1)
      expect(parts2[0].id).toBe('agent-response-1')
      expect(parts2[0].text).toBe('Long response part 1 and part 2')
    })
  })

  describe('Tool call turn detection', () => {
    it('should NOT increment turn ID for tool calls within time threshold', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      // First message chunk
      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Before tool' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1)

      // Tool call (within 2s)
      vi.advanceTimersByTime(500)

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            status: 'completed',
            kind: 'bash',
            rawInput: { command: 'ls' },
            rawOutput: { stdout: 'file.txt' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(
        toolCall,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      // Next message chunk (within 2s — should stay on same turn)
      vi.advanceTimersByTime(500)

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'After tool' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      // Tool calls no longer force a new turn — only time gaps do
      expect(session.currentTurnId).toBe(1)
      expect(parts2[0].id).toBe('agent-response-1')
    })

    it('should cache tool metadata from initial tool_call and use it on completion', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      // Initial tool_call with kind and rawInput (in_progress)
      const toolCallStart = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            status: 'in_progress',
            kind: 'shell',
            title: 'ls -la',
            rawInput: { command: 'ls -la' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(
        toolCallStart,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      // Metadata should be cached
      expect(session.toolCallMetadata.has('tool-1')).toBe(true)
      expect(session.toolCallMetadata.get('tool-1')?.name).toBe('shell')
      expect(session.toolCallMetadata.get('tool-1')?.input).toBe('ls -la')

      // Completed tool_call_update without kind/rawInput (Codex format)
      const toolCallComplete = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: '{"files":[]}' } }],
            rawOutput: { content: [{ text: 'file.txt\ndir/', type: 'text' }], isError: false }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        toolCallComplete,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      // Should use cached metadata for name and input
      expect(parts.length).toBe(1)
      expect(parts[0].type).toBe(MessagePartType.TOOL)
      expect(parts[0].tool?.name).toBe('shell')
      expect(parts[0].tool?.input).toBe('ls -la')
      expect(parts[0].tool?.output).toBe('file.txt\ndir/')

      // Cached metadata should be cleaned up
      expect(session.toolCallMetadata.has('tool-1')).toBe(false)
    })

    it('should extract output from Codex rawOutput content array', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const toolCallComplete = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-2',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: '{"resourceTemplates":[]}' } }],
            rawOutput: { content: [{ text: '{"resourceTemplates":[]}', type: 'text' }], isError: false }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        toolCallComplete,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(parts.length).toBe(1)
      expect(parts[0].tool?.output).toBe('{"resourceTemplates":[]}')
    })
  })

  describe('Message accumulation', () => {
    it('should accumulate chunks with same turn ID', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      // First chunk
      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts1[0].text).toBe('Hello')
      expect(parts1[0].id).toBe('agent-response-1')

      // Second chunk (within 2s)
      vi.advanceTimersByTime(500)

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' World' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts2[0].text).toBe('Hello World') // Accumulated
      expect(parts2[0].id).toBe('agent-response-1') // Same ID
      expect(parts2[0].update).toBe(true) // Marked as update
    })

    it('should create separate messages for different turn IDs', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      // First message
      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts1[0].text).toBe('First')
      expect(parts1[0].id).toBe('agent-response-1')

      // Time gap to trigger new turn
      vi.advanceTimersByTime(3000)

      // Second message (new turn)
      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Second' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts2[0].text).toBe('Second') // Not accumulated with first
      expect(parts2[0].id).toBe('agent-response-2') // Different ID
      expect(parts2[0].update).toBe(false) // Not an update, new message
    })
  })

  describe('Thinking chunks', () => {
    it('should use same turn ID for thinking chunks', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      // Message chunk (establishes turn 1)
      const messageChunk = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(
        messageChunk,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1)

      // Thinking chunk (within 2s)
      vi.advanceTimersByTime(500)

      const thinkingChunk = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'I am thinking...' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        thinkingChunk,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(parts[0].id).toBe('agent-thinking-1') // Uses current turn ID
      expect(parts[0].type).toBe(MessagePartType.REASONING)
    })
  })

  describe('Resume session scenario', () => {
    it('should handle replayed messages with proper turn detection', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      // Simulate replayed messages arriving in quick succession
      // (as they would during session resume)

      // First historical message chunks
      const replay1a = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First reply chunk 1' }
          }
        }
      }

      const replay1b = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' chunk 2' }
          }
        }
      }

      // Process first message chunks (immediate succession)
      priv.convertAcpEventToMessageParts(replay1a, new Set(), seenPartIds, partContentLengths, session)
      vi.advanceTimersByTime(100) // Small delay
      const parts1 = priv.convertAcpEventToMessageParts(replay1b, new Set(), seenPartIds, partContentLengths, session)

      expect(session.currentTurnId).toBe(1)
      expect(parts1[0].id).toBe('agent-response-1')
      expect(parts1[0].text).toContain('First reply chunk 1 chunk 2')

      // Simulate gap before next historical message (tool call or time)
      vi.advanceTimersByTime(3000)

      // Second historical message
      const replay2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Second reply' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(replay2, new Set(), seenPartIds, partContentLengths, session)

      expect(session.currentTurnId).toBe(2) // New turn detected
      expect(parts2[0].id).toBe('agent-response-2') // Different ID
      expect(parts2[0].text).toBe('Second reply')
    })
  })

  describe('Edge cases', () => {
    it('should handle first chunk when lastChunkTime is null', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const chunk = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First chunk ever' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        chunk,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1) // Should create turn 1
      expect(session.lastChunkTime).not.toBeNull() // Should set timestamp
      expect(parts[0].id).toBe('agent-response-1')
    })

    it('should not increment turn ID when session is undefined', async () => {
      const priv = adapterPrivate(adapter)

      // Process message without session context
      const chunk = {
        method: 'session/update',
        params: {
          sessionId: 'unknown',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'No session' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        chunk,
        new Set(),
        new Set(),
        new Map(),
        undefined // No session
      )

      // Should still work but use fallback ID
      expect(parts[0].id).toBe('agent-response') // Default when turnId is 0
    })
  })
})
