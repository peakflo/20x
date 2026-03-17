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
  handlePermissionRequest(session: AcpSessionForTest, request: JsonRpcRequestForTest): void
  sendRpcResponse(session: AcpSessionForTest, id: string | number, result: unknown): void
  updateSessionStatus(session: AcpSessionForTest, notification: unknown): void
}

interface JsonRpcRequestForTest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
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
  config: { permissionMode?: 'ask' | 'allow' }
  promptRequestId: number | null
  responseCounter: number
  currentUserTurnId: number
  lastChunkTime: number | null
  currentTurnId: number
  lastSessionUpdateType: string | null
  activeTurnId: number | null
  pendingAssistantTurnSplit: boolean
  toolCallMetadata: Map<string, { name: string; input: string; title?: string }>
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
    config: { permissionMode: 'ask' },
    promptRequestId: null,
    responseCounter: 0,
    currentUserTurnId: 0,
    lastChunkTime: null,
    currentTurnId: 0,
    lastSessionUpdateType: null,
    activeTurnId: null,
    pendingAssistantTurnSplit: false,
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

  describe('Permission handling', () => {
    it('stores pending approval when permission mode is ask', () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      session.config.permissionMode = 'ask'

      priv.handlePermissionRequest(session, {
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'session/request_permission',
        params: {
          toolCall: {
            rawInput: { reason: 'Run ls' },
            toolCallId: 'tool-1',
            kind: 'shell'
          },
          options: [
            { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
            { optionId: 'abort', name: 'No', kind: 'deny' }
          ]
        }
      })

      expect(session.pendingApproval).toEqual({
        requestId: 'req-1',
        toolCallId: 'tool-1',
        question: 'Run ls',
        options: [
          { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
          { optionId: 'abort', name: 'No', kind: 'deny' }
        ]
      })
    })

    it('auto-approves when permission mode is allow', () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      session.config.permissionMode = 'allow'
      const sendRpcResponseSpy = vi.spyOn(priv, 'sendRpcResponse')

      priv.handlePermissionRequest(session, {
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'session/request_permission',
        params: {
          toolCall: {
            rawInput: { reason: 'Run npm test' },
            toolCallId: 'tool-2',
            kind: 'shell'
          },
          options: [
            { optionId: 'approved-for-session', name: 'Always', kind: 'allow_session' },
            { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
            { optionId: 'abort', name: 'No', kind: 'deny' }
          ]
        }
      })

      expect(session.pendingApproval).toBeNull()
      expect(sendRpcResponseSpy).toHaveBeenCalledWith(session, 'req-2', {
        result: {
          outcome: {
            outcome: 'selected',
            optionId: 'approved-for-session'
          }
        }
      })
    })
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

  describe('Resume buffer handling', () => {
    it('clears replayed messageBuffer after resumeSession loads history', async () => {
      const adapterAny = adapter as any
      const replayEvent = {
        method: 'session/update',
        params: {
          sessionId: 'persisted-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Replayed assistant message' }
          }
        }
      }

      vi.spyOn(adapterAny, 'sendRpcRequest').mockImplementation(async (...args: unknown[]) => {
        const session = args[0] as AcpSessionForTest
        const method = args[1] as string

        if (method === 'initialize' || method === 'authenticate') return {}
        if (method === 'session/load') {
          session.messageBuffer.push(replayEvent)
          session.permanentMessages.push(replayEvent)
          return {}
        }
        return {}
      })

      const messages = await adapter.resumeSession('persisted-session-id', {
        workspaceDir: '/tmp',
        permissionMode: 'default'
      } as any)

      expect(messages).toHaveLength(1)

      const session = adapterPrivate(adapter).sessions.get('persisted-session-id')
      expect(session).toBeTruthy()
      expect(session?.messageBuffer).toHaveLength(0)

      const polled = await adapter.pollMessages(
        'persisted-session-id',
        new Set(),
        new Set(),
        new Map(),
        {} as any
      )
      expect(polled).toHaveLength(0)
    })
  })

  describe('Tool call turn detection', () => {
    it('should start a new turn after a completed tool call within an active prompt turn', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      session.currentTurnId = 1
      session.activeTurnId = 1

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

      // Tool call inside the same prompt turn
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

      // Next assistant chunk after a completed tool call should become a new turn
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

      expect(session.currentTurnId).toBe(2)
      expect(parts2[0].id).toBe('agent-response-2')
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
      expect(parts[0].tool?.title).toBe('ls -la')
      expect(parts[0].tool?.input).toBe('ls -la')
      expect(parts[0].tool?.output).toBe('file.txt\ndir/')

      // Cached metadata should be cleaned up
      expect(session.toolCallMetadata.has('tool-1')).toBe(false)
    })

    it('should normalize exec_command to command and use command as title', async () => {
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
            toolCallId: 'tool-1',
            status: 'completed',
            title: 'exec_command',
            rawInput: { command: 'pwd' },
            rawOutput: { stdout: '/tmp' }
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

      expect(parts).toHaveLength(1)
      expect(parts[0].tool?.name).toBe('command')
      expect(parts[0].tool?.title).toBe('pwd')
      expect(parts[0].tool?.input).toBe('pwd')
    })

    it('should use rawInput.cmd for exec_command title', async () => {
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
            toolCallId: 'tool-cmd',
            status: 'completed',
            title: 'exec_command',
            rawInput: { cmd: 'pwd' },
            rawOutput: { stdout: '/tmp' }
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

      expect(parts).toHaveLength(1)
      expect(parts[0].tool?.name).toBe('command')
      expect(parts[0].tool?.title).toBe('pwd')
      expect(parts[0].tool?.input).toBe('pwd')
    })

    it('should normalize write_stdin and summarize chars as title', async () => {
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
            toolCallId: 'tool-stdin',
            status: 'completed',
            title: 'write_stdin',
            rawInput: { chars: 'y\n' },
            rawOutput: { stdout: '' }
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

      expect(parts).toHaveLength(1)
      expect(parts[0].tool?.name).toBe('stdin')
      expect(parts[0].tool?.title).toBe('y')
    })

    it('should normalize update_plan and summarize first step as title', async () => {
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
            toolCallId: 'tool-plan',
            status: 'completed',
            title: 'update_plan',
            rawInput: {
              plan: [
                { step: 'Trace replay messages', status: 'completed' },
                { step: 'Patch transcript labels', status: 'in_progress' }
              ]
            },
            rawOutput: { stdout: '' }
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

      expect(parts).toHaveLength(1)
      expect(parts[0].tool?.name).toBe('plan')
      expect(parts[0].tool?.title).toBe('2 steps: Trace replay messages')
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

    it('keeps separate replayed user and assistant turns even without time gaps', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      priv.sessions.set(sessionId, session)

      const firstUser = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'First task prompt' }
          }
        }
      }

      const firstAssistant = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First assistant reply' }
          }
        }
      }

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'exec_command',
            status: 'completed',
            rawInput: { command: 'pwd' }
          }
        }
      }

      const secondUser = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Second task prompt' }
          }
        }
      }

      const secondAssistant = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Second assistant reply' }
          }
        }
      }

      const firstUserParts = priv.convertAcpEventToMessageParts(firstUser, new Set(), seenPartIds, partContentLengths, session)
      const firstAssistantParts = priv.convertAcpEventToMessageParts(firstAssistant, new Set(), seenPartIds, partContentLengths, session)
      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)
      const secondUserParts = priv.convertAcpEventToMessageParts(secondUser, new Set(), seenPartIds, partContentLengths, session)
      const secondAssistantParts = priv.convertAcpEventToMessageParts(secondAssistant, new Set(), seenPartIds, partContentLengths, session)

      expect(firstUserParts[0].id).toBe('user-message-1')
      expect(secondUserParts[0].id).toBe('user-message-2')
      expect(firstAssistantParts[0].id).toBe('agent-response-1')
      expect(secondAssistantParts[0].id).toBe('agent-response-2')
      expect(secondAssistantParts[0].text).toBe('Second assistant reply')
    })

    it('starts a new assistant turn after tool activity even with active prompt turn', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      session.currentTurnId = 1
      session.activeTurnId = 1
      session.lastSessionUpdateType = 'agent_message_chunk'
      priv.sessions.set(sessionId, session)

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-active',
            title: 'exec_command',
            status: 'completed',
            rawInput: { cmd: 'pwd' }
          }
        }
      }

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Here is the result.' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)
      const afterToolParts = priv.convertAcpEventToMessageParts(assistantAfterTool, new Set(), seenPartIds, partContentLengths, session)

      expect(session.currentTurnId).toBe(2)
      expect(session.activeTurnId).toBe(2)
      expect(afterToolParts[0].id).toBe('agent-response-2')
    })

    it('does NOT clear activeTurnId in updateSessionStatus (turn state managed only during polling)', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      session.currentTurnId = 1
      session.activeTurnId = 1
      session.lastSessionUpdateType = 'agent_message_chunk'
      priv.sessions.set(sessionId, session)

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-live',
            title: 'exec_command',
            status: 'completed',
            rawInput: { cmd: 'pwd' }
          }
        }
      }

      // updateSessionStatus should NOT modify turn-related state (activeTurnId,
      // pendingAssistantTurnSplit) — that's handled by convertAcpEventToMessageParts
      // during polling to avoid race conditions with real-time event arrival.
      priv.updateSessionStatus(session, toolCall as never)
      expect(session.activeTurnId).toBe(1) // Preserved — turn state managed only during polling

      // Process the tool call through the polling path
      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)
      // Now pendingAssistantTurnSplit is set by convertAcpEventToMessageParts

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Here is the result.' }
          }
        }
      }

      const afterToolParts = priv.convertAcpEventToMessageParts(assistantAfterTool, new Set(), seenPartIds, partContentLengths, session)

      expect(session.currentTurnId).toBe(2)
      expect(session.activeTurnId).toBe(2) // Updated by getAssistantTurnId
      expect(afterToolParts[0].id).toBe('agent-response-2')
    })

    it('starts a new live assistant turn after usage_update follows a tool call', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      session.currentTurnId = 1
      session.activeTurnId = 1
      session.lastSessionUpdateType = 'agent_message_chunk'
      priv.sessions.set(sessionId, session)

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-live-usage',
            title: 'Run pwd',
            status: 'completed',
            rawInput: { command: ['pwd'] }
          }
        }
      }

      const usageUpdate = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'usage_update'
          }
        }
      }

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'am2' }
          }
        }
      }

      priv.updateSessionStatus(session, toolCall as never)
      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)
      priv.convertAcpEventToMessageParts(usageUpdate, new Set(), seenPartIds, partContentLengths, session)
      const afterToolParts = priv.convertAcpEventToMessageParts(assistantAfterTool, new Set(), seenPartIds, partContentLengths, session)

      expect(session.pendingAssistantTurnSplit).toBe(false)
      expect(session.currentTurnId).toBe(2)
      expect(afterToolParts[0].id).toBe('agent-response-2')
      expect(afterToolParts[0].text).toBe('am2')
    })

    it('starts a new assistant replay turn after tool activity', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      priv.sessions.set(sessionId, session)

      const assistantBeforeTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Let me inspect that.' }
          }
        }
      }

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-2',
            title: 'exec_command',
            status: 'completed',
            rawInput: { command: 'ls' }
          }
        }
      }

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'I found the issue.' }
          }
        }
      }

      const beforeToolParts = priv.convertAcpEventToMessageParts(assistantBeforeTool, new Set(), seenPartIds, partContentLengths, session)
      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)
      const afterToolParts = priv.convertAcpEventToMessageParts(assistantAfterTool, new Set(), seenPartIds, partContentLengths, session)

      expect(beforeToolParts[0].id).toBe('agent-response-1')
      expect(afterToolParts[0].id).toBe('agent-response-2')
      expect(afterToolParts[0].text).toBe('I found the issue.')
    })
  })

  describe('Resume message grouping', () => {
    it('keeps assistant text after tool calls as a separate resumed message', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      const assistantBeforeTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Let me inspect that.' }
          }
        }
      }

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-2',
            title: 'exec_command',
            status: 'completed',
            rawInput: { cmd: 'pwd' }
          }
        }
      }

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'I found the issue.' }
          }
        }
      }

      session.permanentMessages.push(assistantBeforeTool, toolCall, assistantAfterTool)
      priv.sessions.set(sessionId, session)

      const messages = await adapter.getAllMessages(sessionId, {
        agentId: 'codex',
        taskId: 'task-1',
        workspaceDir: '/tmp'
      })

      expect(messages).toHaveLength(3)
      expect(messages[0].parts[0].id).toBe('agent-response-1')
      expect(messages[1].parts[0].id).toBe('tool-2')
      expect(messages[2].parts[0].id).toBe('agent-response-2')
      expect(messages[2].parts[0].text).toBe('I found the issue.')
    })
  })

  describe('Edge cases', () => {
    it('converts non-chunk replayed user and agent messages', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      priv.sessions.set(sessionId, session)

      const userMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message',
            messageId: 'user-1',
            content: { type: 'text', text: 'Please run tests' }
          }
        }
      }

      const agentMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message',
            messageId: 'assistant-1',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'Running tests now.' }
              }
            ]
          }
        }
      }

      const userParts = priv.convertAcpEventToMessageParts(userMessage, new Set(), seenPartIds, partContentLengths, session)
      const agentParts = priv.convertAcpEventToMessageParts(agentMessage, new Set(), seenPartIds, partContentLengths, session)

      expect(userParts).toHaveLength(1)
      expect(userParts[0].role).toBe('user')
      expect(userParts[0].type).toBe(MessagePartType.TEXT)
      expect(userParts[0].text).toBe('Please run tests')

      expect(agentParts).toHaveLength(1)
      expect(agentParts[0].role).toBe('assistant')
      expect(agentParts[0].type).toBe(MessagePartType.TEXT)
      expect(agentParts[0].text).toBe('Running tests now.')
    })

    it('converts alternate completed message aliases and array text shapes', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      priv.sessions.set(sessionId, session)

      const assistantMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'assistant_message',
            messageId: 'assistant-2',
            content: [
              { type: 'text', text: 'Done inspecting resume history.' },
              { type: 'text', text: 'Found the gap.' }
            ]
          }
        }
      }

      const humanMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'human_message',
            messageId: 'user-2',
            content: {
              type: 'wrapper',
              content: { type: 'text', text: 'Please keep digging.' }
            }
          }
        }
      }

      const assistantParts = priv.convertAcpEventToMessageParts(assistantMessage, new Set(), seenPartIds, partContentLengths, session)
      const humanParts = priv.convertAcpEventToMessageParts(humanMessage, new Set(), seenPartIds, partContentLengths, session)

      expect(assistantParts).toHaveLength(1)
      expect(assistantParts[0].role).toBe('assistant')
      expect(assistantParts[0].text).toBe('Done inspecting resume history.\nFound the gap.')

      expect(humanParts).toHaveLength(1)
      expect(humanParts[0].role).toBe('user')
      expect(humanParts[0].text).toBe('Please keep digging.')
    })

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

// ── Fix Tests: Message Duplication, User Messages, Function Calls ────

describe('AcpAdapter - sendPrompt buffer clearing', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter('codex')
  })

  it('should clear messageBuffer on sendPrompt to prevent stale event duplication', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-buffer')
    session.process = {
      stdin: { write: vi.fn() }
    } as unknown as ChildProcess
    priv.sessions.set('sess-buffer', session)

    // Simulate stale events from the previous turn
    session.messageBuffer.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'stale text from old turn' }
        }
      }
    })

    // Send a new prompt — should clear stale buffer
    await adapter.sendPrompt('sess-buffer', [{ type: MessagePartType.TEXT, text: 'New prompt' }], {} as never)

    // The buffer should be empty (stale events cleared)
    expect(session.messageBuffer).toEqual([])
  })

  it('should store synthetic user_message in permanentMessages on sendPrompt', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-usermsg')
    session.process = {
      stdin: { write: vi.fn() }
    } as unknown as ChildProcess
    priv.sessions.set('sess-usermsg', session)

    await adapter.sendPrompt('sess-usermsg', [{ type: MessagePartType.TEXT, text: 'Hello agent' }], {} as never)

    // permanentMessages should contain the synthetic user_message event
    const userEvent = session.permanentMessages.find((e: unknown) => {
      const params = (e as { params?: { update?: { sessionUpdate?: string } } }).params
      return params?.update?.sessionUpdate === 'user_message'
    })
    expect(userEvent).toBeDefined()

    // The event should contain the prompt text
    const params = (userEvent as { params: { update: { content: { text: string } } } }).params
    expect(params.update.content.text).toBe('Hello agent')
  })

  it('synthetic user messages should appear in getAllMessages replay', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-replay')
    session.process = {
      stdin: { write: vi.fn() }
    } as unknown as ChildProcess
    priv.sessions.set('sess-replay', session)

    // Send a prompt (stores synthetic user_message in permanentMessages)
    await adapter.sendPrompt('sess-replay', [{ type: MessagePartType.TEXT, text: 'Work on task' }], {} as never)

    // Add an agent response to permanentMessages
    session.permanentMessages.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'I will work on it.' }
        }
      }
    })

    // getAllMessages should include both user and agent messages
    const messages = await adapter.getAllMessages('sess-replay', {} as never)
    const userParts = messages.flatMap(m => m.parts).filter(p => p.text?.includes('Work on task'))
    const agentParts = messages.flatMap(m => m.parts).filter(p => p.text?.includes('I will work on it'))

    expect(userParts.length).toBeGreaterThan(0)
    expect(agentParts.length).toBeGreaterThan(0)
  })
})

describe('AcpAdapter - In-progress tool call visibility', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter('codex')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should emit a running tool part for in_progress tool_call events', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool')
    const seenPartIds = new Set<string>()

    const inProgressEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-abc',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'ls -la' }
        }
      }
    }

    const parts = priv.convertAcpEventToMessageParts(
      inProgressEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    // Should emit a tool part with running status
    expect(parts.length).toBe(1)
    expect(parts[0].type).toBe(MessagePartType.TOOL)
    expect(parts[0].tool?.status).toBe('running')
    expect(parts[0].tool?.name).toBe('command')
    expect(parts[0].id).toBe('tool-abc')
    expect(seenPartIds.has('tool-abc')).toBe(true)
  })

  it('should update running tool to completed with output and update flag', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool2')
    const seenPartIds = new Set<string>()

    // First: in_progress event
    const inProgressEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-xyz',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'cat file.txt' }
        }
      }
    }
    priv.convertAcpEventToMessageParts(inProgressEvent, new Set(), seenPartIds, new Map(), session)

    // seenPartIds should have the tool
    expect(seenPartIds.has('tool-xyz')).toBe(true)

    // Then: completed event
    const completedEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-xyz',
          status: 'completed',
          rawOutput: { stdout: 'file contents here' }
        }
      }
    }

    const completedParts = priv.convertAcpEventToMessageParts(
      completedEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    // Should emit completed tool part with update flag
    expect(completedParts.length).toBe(1)
    expect(completedParts[0].type).toBe(MessagePartType.TOOL)
    expect(completedParts[0].tool?.status).toBe('completed')
    expect(completedParts[0].tool?.output).toBe('file contents here')
    expect(completedParts[0].update).toBe(true) // Should be marked as update
  })

  it('should create completed tool part even without prior in_progress event', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool3')
    const seenPartIds = new Set<string>()

    // Only completed event (no prior in_progress)
    const completedEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-direct',
          kind: 'exec_command',
          status: 'completed',
          rawInput: { command: 'echo hello' },
          rawOutput: { stdout: 'hello' }
        }
      }
    }

    const parts = priv.convertAcpEventToMessageParts(
      completedEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    expect(parts.length).toBe(1)
    expect(parts[0].tool?.status).toBe('completed')
    expect(parts[0].tool?.output).toBe('hello')
    expect(parts[0].update).toBe(false) // No prior part, so not an update
  })
})

// ─── Bug fix tests: codex messages garbage (duplication, user messages, tool calls) ───

describe('AcpAdapter - sendPrompt clears stale messageBuffer', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter('codex')
  })

  it('should clear messageBuffer on sendPrompt to prevent duplication on next poll', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-dedup')
    session.messageBuffer = [
      { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale' } } } },
      { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'old-tool', status: 'in_progress' } } }
    ]
    session.permanentMessages = []
    session.process = {
      stdin: { write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => { if (cb) cb(null) }) }
    } as unknown as ChildProcess

    priv.sessions.set('sess-dedup', session)

    // sendPrompt should clear the stale messageBuffer
    await adapter.sendPrompt('sess-dedup', [{ type: MessagePartType.TEXT, text: 'new prompt' }], {} as never)

    expect(session.messageBuffer).toEqual([])
  })

  it('should add synthetic user_message to permanentMessages for resume', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-user')
    session.permanentMessages = []
    session.process = {
      stdin: { write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => { if (cb) cb(null) }) }
    } as unknown as ChildProcess

    priv.sessions.set('sess-user', session)

    await adapter.sendPrompt('sess-user', [{ type: MessagePartType.TEXT, text: 'Hello agent' }], {} as never)

    // permanentMessages should contain a synthetic user_message
    const userEvents = session.permanentMessages.filter((e) => {
      const params = (e as { params?: { update?: { sessionUpdate?: string } } }).params
      return params?.update?.sessionUpdate === 'user_message'
    })

    expect(userEvents.length).toBe(1)
    const event = userEvents[0] as { params: { update: { content: { text: string }; messageId: string } } }
    expect(event.params.update.content.text).toBe('Hello agent')
    expect(event.params.update.messageId).toMatch(/^user-prompt-/)
  })

  it('should NOT leave stale events that cause duplicated messages after idle+restart', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-idle')

    // Simulate stale events left in messageBuffer after idle
    session.messageBuffer = [
      { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old text' } } } }
    ]
    session.process = {
      stdin: { write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => { if (cb) cb(null) }) }
    } as unknown as ChildProcess

    priv.sessions.set('sess-idle', session)

    // sendPrompt clears the buffer before the new prompt starts
    await adapter.sendPrompt('sess-idle', [{ type: MessagePartType.TEXT, text: 'fresh prompt' }], {} as never)

    // Now poll — should get NO messages (buffer was cleared)
    const parts = await adapter.pollMessages('sess-idle', new Set(), new Set(), new Map(), {} as never)
    expect(parts).toEqual([])
  })
})

describe('AcpAdapter - In-progress tool parts', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter('codex')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should emit in-progress tool part immediately when tool_call arrives', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool-progress')
    const seenPartIds = new Set<string>()

    const toolCallInProgress = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-ip-1',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'npm test' }
        }
      }
    }

    const parts = priv.convertAcpEventToMessageParts(
      toolCallInProgress,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    // Should emit a running tool part
    expect(parts.length).toBe(1)
    expect(parts[0].id).toBe('tool-ip-1')
    expect(parts[0].type).toBe(MessagePartType.TOOL)
    expect(parts[0].tool?.status).toBe('running')
    expect(parts[0].tool?.name).toBe('command')
  })

  it('should update in-progress tool part when completed', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool-update')
    const seenPartIds = new Set<string>()

    // First: in-progress event
    const inProgressEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-up-1',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'ls -la' }
        }
      }
    }

    priv.convertAcpEventToMessageParts(
      inProgressEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    expect(seenPartIds.has('tool-up-1')).toBe(true)

    // Second: completed event
    const completedEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-up-1',
          kind: 'exec_command',
          status: 'completed',
          rawInput: { command: 'ls -la' },
          rawOutput: { stdout: 'file1\nfile2' }
        }
      }
    }

    const completedParts = priv.convertAcpEventToMessageParts(
      completedEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    expect(completedParts.length).toBe(1)
    expect(completedParts[0].id).toBe('tool-up-1')
    expect(completedParts[0].tool?.status).toBe('completed')
    expect(completedParts[0].tool?.output).toBe('file1\nfile2')
    expect(completedParts[0].update).toBe(true) // marked as update since in-progress was already emitted
  })

  it('should NOT duplicate in-progress tool part when same toolCallId arrives twice', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool-nodup')
    const seenPartIds = new Set<string>()

    const toolCallEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-dup-1',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'echo hi' }
        }
      }
    }

    // First call
    const parts1 = priv.convertAcpEventToMessageParts(
      toolCallEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )
    expect(parts1.length).toBe(1)

    // Second call with same toolCallId
    const parts2 = priv.convertAcpEventToMessageParts(
      toolCallEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )
    // Should NOT emit another in-progress part
    expect(parts2.length).toBe(0)
  })
})

describe('AcpAdapter - User message handling', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter('codex')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should convert user_message events to user-role parts', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-user-msg')

    const userMessageEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message',
          messageId: 'user-msg-1',
          content: { type: 'text', text: 'Hello from user' }
        }
      }
    }

    const parts = priv.convertAcpEventToMessageParts(
      userMessageEvent,
      new Set(),
      new Set(),
      new Map(),
      session
    )

    expect(parts.length).toBe(1)
    expect(parts[0].role).toBe('user')
    expect(parts[0].text).toBe('Hello from user')
    expect(parts[0].id).toBe('user-msg-1')
  })

  it('should accumulate user_message_chunk events', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-user-chunks')
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const chunk1 = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Hello ' }
        }
      }
    }

    const parts1 = priv.convertAcpEventToMessageParts(
      chunk1, new Set(), seenPartIds, partContentLengths, session
    )

    expect(parts1.length).toBe(1)
    expect(parts1[0].role).toBe('user')
    expect(parts1[0].text).toBe('Hello ')

    const chunk2 = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'world' }
        }
      }
    }

    const parts2 = priv.convertAcpEventToMessageParts(
      chunk2, new Set(), seenPartIds, partContentLengths, session
    )

    expect(parts2.length).toBe(1)
    expect(parts2[0].role).toBe('user')
    expect(parts2[0].text).toBe('Hello world')
    expect(parts2[0].update).toBe(true) // streaming update
  })

  it('synthetic user_message in permanentMessages survives getAllMessages', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-resume-user')

    // Simulate what sendPrompt does: add synthetic user_message
    session.permanentMessages.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message',
          content: { type: 'text', text: 'User prompt text' },
          messageId: 'user-prompt-1'
        }
      }
    })

    // Also add an agent response
    session.permanentMessages.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Agent response' }
        }
      }
    })

    priv.sessions.set('sess-resume-user', session)

    const messages = await adapter.getAllMessages('sess-resume-user', {} as never)

    // Should have both user and assistant messages
    const userMessages = messages.filter(m => m.role === 'user')
    const assistantMessages = messages.filter(m => m.role === 'assistant')

    expect(userMessages.length).toBe(1)
    expect(userMessages[0].parts[0].text).toBe('User prompt text')
    expect(assistantMessages.length).toBe(1)
    expect(assistantMessages[0].parts[0].text).toBe('Agent response')
  })
})

// ─── Regression tests: available_commands_update / plan must NOT cause turn splits ───

describe('AcpAdapter - Non-content events must not fragment assistant messages', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter('codex')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('available_commands_update between chunks should NOT start a new turn', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-cmd-update')
    session.currentTurnId = 1
    session.activeTurnId = 1
    session.lastSessionUpdateType = 'agent_message_chunk'
    priv.sessions.set('sess-cmd-update', session)

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    // First assistant chunk
    const chunk1 = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } }
    }
    priv.convertAcpEventToMessageParts(chunk1, new Set(), seenPartIds, partContentLengths, session)
    expect(session.currentTurnId).toBe(1)

    // available_commands_update arrives (non-content event)
    const cmdUpdate = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'available_commands_update' } }
    }
    priv.convertAcpEventToMessageParts(cmdUpdate, new Set(), seenPartIds, partContentLengths, session)

    // Second assistant chunk — should continue same turn
    const chunk2 = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } }
    }
    const parts2 = priv.convertAcpEventToMessageParts(chunk2, new Set(), seenPartIds, partContentLengths, session)

    expect(session.currentTurnId).toBe(1) // SAME turn — no split
    expect(parts2[0].id).toBe('agent-response-1') // same message ID
    expect(parts2[0].text).toBe('Hello world') // accumulated text
  })

  it('plan event between chunks should NOT start a new turn', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-plan')
    session.currentTurnId = 1
    session.activeTurnId = 1
    session.lastSessionUpdateType = 'agent_message_chunk'
    priv.sessions.set('sess-plan', session)

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    // First chunk
    const chunk1 = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Step 1: ' } } }
    }
    priv.convertAcpEventToMessageParts(chunk1, new Set(), seenPartIds, partContentLengths, session)

    // plan event
    const planEvent = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'plan', entries: [{ content: 'step 1', priority: 'high', status: 'pending' }] } }
    }
    priv.convertAcpEventToMessageParts(planEvent, new Set(), seenPartIds, partContentLengths, session)

    // Second chunk — should continue same turn
    const chunk2 = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'read file' } } }
    }
    const parts2 = priv.convertAcpEventToMessageParts(chunk2, new Set(), seenPartIds, partContentLengths, session)

    expect(session.currentTurnId).toBe(1) // SAME turn
    expect(parts2[0].id).toBe('agent-response-1')
    expect(parts2[0].text).toBe('Step 1: read file')
  })

  it('updateSessionStatus should NOT modify turn state (activeTurnId, pendingAssistantTurnSplit)', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-status')
    session.currentTurnId = 1
    session.activeTurnId = 1
    session.pendingAssistantTurnSplit = false
    priv.sessions.set('sess-status', session)

    const toolNotification = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', status: 'in_progress' } }
    }

    priv.updateSessionStatus(session, toolNotification as never)

    // Status should be updated
    expect(session.status).toBe('busy')
    // Turn state should NOT be modified by updateSessionStatus
    expect(session.activeTurnId).toBe(1)
    expect(session.pendingAssistantTurnSplit).toBe(false)
  })
})
