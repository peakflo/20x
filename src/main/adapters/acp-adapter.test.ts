/**
 * Tests for ACP Adapter turn-based message ID detection
 */

import { ChildProcess } from 'child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AcpAdapter } from './acp-adapter'
import { SessionStatusType, MessagePartType, MessagePart, SessionConfig } from './coding-agent-adapter'

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

      vi.spyOn(adapterAny, 'sendRpcRequest').mockImplementation(async (session: AcpSessionForTest, method: string) => {
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
    it('should NOT increment turn ID for tool calls within an active prompt turn', async () => {
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

      // Next message chunk in the same prompt turn should keep the same turn ID
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

    it('clears active turn immediately when live tool activity arrives', async () => {
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

      priv.updateSessionStatus(session, toolCall as never)
      expect(session.activeTurnId).toBeNull()

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
