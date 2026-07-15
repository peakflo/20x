import { describe, it, expect, vi } from 'vitest'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import { MessagePartType, MessageRole, SessionStatusType } from './coding-agent-adapter'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn((_cmd, _args, callback) => callback(null, '/usr/local/bin/codex\n', ''))
}))

interface AppServerAdapterPrivate {
  sessions: Map<string, AppServerSessionForTest>
  handleRpcMessage(session: AppServerSessionForTest, message: unknown): void
  convertEventToMessageParts(
    event: unknown,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session: AppServerSessionForTest
  ): Array<{
    id?: string
    type: MessagePartType
    text?: string
    role?: string
    update?: boolean
    tool?: { name: string; status?: string; input?: unknown; output?: unknown }
  }>
  buildEnvironment(config: {
    authMethod?: 'subscription' | 'api_key'
    apiKeys?: { openai?: string }
    secretEnvVars?: Record<string, string>
  }): {
    env: NodeJS.ProcessEnv
    usesApiKey: boolean
    summary: string
  }
  buildConfigOverrides(config: {
    workspaceDir: string
    reasoningEffort?: string
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
    mcpServers?: Record<string, {
      type: 'stdio' | 'http' | 'sse'
      command?: string
      args?: string[]
      env?: Record<string, string>
      url?: string
      headers?: Record<string, string>
    }>
  }): Record<string, unknown>
  bufferAllThreadItems(session: AppServerSessionForTest, threadId: string): Promise<void>
  sendRpcRequest(session: AppServerSessionForTest, method: string, params?: unknown): Promise<unknown>
}

interface AppServerSessionForTest {
  sessionId: string
  threadId: string | null
  activeTurnId: string | null
  process: {
    stdin: { write: ReturnType<typeof vi.fn> }
  }
  stdoutBuffer: string
  status: SessionStatusType
  messageBuffer: unknown[]
  permanentMessages: unknown[]
  bufferedThreadItemIds: Set<string>
  pendingCompletionRefreshes: number
  sawThreadStatusNotification: boolean
  pendingThreadIdle: boolean
  pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>
  pendingApproval: unknown | null
  nextRequestId: number
  lastError: string | null
  config: { permissionMode?: 'ask' | 'allow'; sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' }
  streamedTextByItemId: Map<string, string>
  assistantTextKeysByTurn: Map<string, Set<string>>
  runningTools: Map<string, {
    partId: string
    toolName: string
    startTime?: number
    input?: Record<string, unknown>
  }>
  codexUseApiKey: boolean
  codexAuthSummary: string
}

function adapterPrivate(adapter: CodexAppServerAdapter): AppServerAdapterPrivate {
  return adapter as unknown as AppServerAdapterPrivate
}

function createSession(): AppServerSessionForTest {
  return {
    sessionId: 'task-1',
    threadId: 'thread-1',
    activeTurnId: null,
    process: { stdin: { write: vi.fn() } },
    stdoutBuffer: '',
    status: SessionStatusType.IDLE,
    messageBuffer: [],
    permanentMessages: [],
    bufferedThreadItemIds: new Set(),
    pendingCompletionRefreshes: 0,
    sawThreadStatusNotification: false,
    pendingThreadIdle: false,
    pendingRequests: new Map(),
    pendingApproval: null,
    nextRequestId: 1,
    lastError: null,
    config: { permissionMode: 'ask' },
    streamedTextByItemId: new Map(),
    assistantTextKeysByTurn: new Map(),
    runningTools: new Map(),
    codexUseApiKey: false,
    codexAuthSummary: ''
  }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('CodexAppServerAdapter', () => {
  it('accumulates agent message deltas into an updating text part', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const lengths = new Map<string, string>()

    const first = adapter.convertEventToMessageParts({
      method: 'item/agentMessage/delta',
      params: { itemId: 'item-1', delta: 'hel', threadId: 'thread-1', turnId: 'turn-1' }
    }, seenMessageIds, seenPartIds, lengths, session)

    const second = adapter.convertEventToMessageParts({
      method: 'item/agentMessage/delta',
      params: { itemId: 'item-1', delta: 'lo', threadId: 'thread-1', turnId: 'turn-1' }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(first[0]).toMatchObject({
      id: 'agent-item-1',
      type: MessagePartType.TEXT,
      text: 'hel',
      role: MessageRole.ASSISTANT,
      update: false
    })
    expect(second[0]).toMatchObject({
      id: 'agent-item-1',
      type: MessagePartType.TEXT,
      text: 'hello',
      role: MessageRole.ASSISTANT,
      update: true
    })
  })

  it('converts generic assistant message items into final text parts', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const lengths = new Map<string, string>()

    const parts = adapter.convertEventToMessageParts({
      method: 'item/completed',
      params: {
        item: {
          id: 'final-1',
          type: 'message',
          role: 'assistant',
          content: 'Here is the app: https://3050-example.runworkflo.com/?exec=abc'
        },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      id: 'agent-final-1',
      type: MessagePartType.TEXT,
      text: 'Here is the app: https://3050-example.runworkflo.com/?exec=abc',
      role: MessageRole.ASSISTANT
    })
    expect(parts[0].tool).toBeUndefined()
  })

  it('deduplicates identical assistant final messages from different item ids in the same turn', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const lengths = new Map<string, string>()
    const finalText = 'Updated and verified.\n\nLatest link:\nhttps://3050-example.runworkflo.com/?exec=abc'

    const first = adapter.convertEventToMessageParts({
      method: 'item/completed',
      params: {
        item: {
          id: 'agent-message-final',
          type: 'agent_message',
          role: 'assistant',
          content: finalText
        },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    }, seenMessageIds, seenPartIds, lengths, session)

    const duplicate = adapter.convertEventToMessageParts({
      method: 'item/completed',
      params: {
        item: {
          id: 'response-item-message-final',
          type: 'message',
          role: 'assistant',
          content: finalText
        },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      id: 'agent-agent-message-final',
      type: MessagePartType.TEXT,
      text: finalText,
      role: MessageRole.ASSISTANT
    })
    expect(duplicate).toHaveLength(0)
  })

  it('reconciles completed turns before reporting idle so final text is not lost', async () => {
    const adapterInstance = new CodexAppServerAdapter()
    const adapter = adapterPrivate(adapterInstance)
    const session = createSession()
    session.status = SessionStatusType.BUSY
    adapter.sessions.set('thread-1', session)

    adapter.handleRpcMessage(session, {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    })

    expect(session.status).toBe(SessionStatusType.BUSY)
    expect(session.pendingCompletionRefreshes).toBe(1)
    expect(session.pendingRequests.size).toBe(1)

    const pending = Array.from(session.pendingRequests.values())[0]
    pending.resolve({
      data: [{
        id: 'final-1',
        type: 'message',
        role: 'assistant',
        content: 'Done: https://3050-example.runworkflo.com/?exec=abc',
        turnId: 'turn-1'
      }]
    })
    await flushPromises()

    expect(session.pendingCompletionRefreshes).toBe(0)
    expect(session.status).toBe(SessionStatusType.IDLE)

    const parts = await adapterInstance.pollMessages(
      'thread-1',
      new Set(),
      new Set(),
      new Map(),
      {} as never
    )

    expect(parts).toEqual([
      expect.objectContaining({
        id: 'agent-final-1',
        type: MessagePartType.TEXT,
        role: MessageRole.ASSISTANT,
        text: 'Done: https://3050-example.runworkflo.com/?exec=abc'
      })
    ])
  })

  it('does not repeat id-less thread items after each completed turn reconcile', async () => {
    // Regression: Codex thread items such as function_call_output /
    // custom_tool_call_output / user+developer input messages have NO top-level
    // `id` (only `call_id`). reconcileCompletedTurn() re-lists the whole thread
    // on every turn/completed. Because bufferedThreadItemIds only registered
    // items that had `item.id` and extractItemId fell back to `item-${Date.now()}`,
    // these id-less items were re-buffered and re-emitted with a brand new part id
    // on every idle — so the transcript repeated older messages after each turn.
    const adapterInstance = new CodexAppServerAdapter()
    const adapter = adapterPrivate(adapterInstance)
    const session = createSession()
    adapter.sessions.set('thread-1', session)

    // Mirrors a codex function_call_output item: no `id`, only `call_id`.
    const idLessToolOutput = {
      type: 'commandExecution',
      call_id: 'call_abc123',
      command: 'ls -la',
      aggregatedOutput: 'file1\nfile2',
      turnId: 'turn-1'
    }

    const reconcileTurn = async (turnId: string): Promise<void> => {
      session.status = SessionStatusType.BUSY
      adapter.handleRpcMessage(session, {
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: 'thread-1', turnId }
      })
      // Resolve the newest thread/items/list request, mirroring how the real
      // JSON-RPC response handler settles + removes it.
      const entries = Array.from(session.pendingRequests.entries())
      const [id, pending] = entries[entries.length - 1]
      session.pendingRequests.delete(id)
      pending.resolve({ data: [idLessToolOutput], nextCursor: null })
      await flushPromises()
    }

    await reconcileTurn('turn-1')
    await reconcileTurn('turn-2')
    await reconcileTurn('turn-3')

    // The same tool output must only ever be buffered once, no matter how many
    // turns complete afterwards. Buffering it again re-emits it to the renderer
    // with a fresh (Date.now-based) part id that dedup can't collapse.
    const bufferedCopies = session.permanentMessages.filter((event) => {
      const item = (event as { params?: { item?: { call_id?: string } } })?.params?.item
      return item?.call_id === 'call_abc123'
    })
    expect(bufferedCopies).toHaveLength(1)
    expect(session.bufferedThreadItemIds.size).toBeGreaterThan(0)
  })

  it('keeps the session busy when a completed turn is followed by an active thread status', async () => {
    const adapterInstance = new CodexAppServerAdapter()
    const adapter = adapterPrivate(adapterInstance)
    const session = createSession()
    session.status = SessionStatusType.BUSY
    adapter.sessions.set('thread-1', session)

    adapter.handleRpcMessage(session, {
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: { type: 'active', activeFlags: ['model'] }
      }
    })

    adapter.handleRpcMessage(session, {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    })

    const pending = Array.from(session.pendingRequests.values())[0]
    pending.resolve({
      data: [{
        id: 'progress-after-turn',
        type: 'message',
        role: 'assistant',
        content: 'Still checking the result',
        turnId: 'turn-1'
      }]
    })
    await flushPromises()

    expect(session.status).toBe(SessionStatusType.BUSY)
    expect(session.pendingCompletionRefreshes).toBe(0)

    adapter.handleRpcMessage(session, {
      jsonrpc: '2.0',
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-1',
        status: { type: 'idle' }
      }
    })

    expect(session.status).toBe(SessionStatusType.IDLE)

    const parts = await adapterInstance.pollMessages(
      'thread-1',
      new Set(),
      new Set(),
      new Map(),
      {} as never
    )

    expect(parts).toEqual([
      expect.objectContaining({
        id: 'agent-progress-after-turn',
        text: 'Still checking the result'
      })
    ])
  })

  it('tracks running tool items and clears them on completion', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const lengths = new Map<string, string>()

    const started = adapter.convertEventToMessageParts({
      method: 'item/started',
      params: {
        startedAtMs: 123,
        item: { id: 'tool-1', type: 'commandExecution', command: 'pnpm test' },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(started[0]).toMatchObject({
      id: 'tool-tool-1',
      type: MessagePartType.TOOL,
      tool: { name: 'commandExecution', status: 'running' }
    })
    expect(session.runningTools.get('tool-tool-1')).toMatchObject({
      partId: 'tool-tool-1',
      toolName: 'commandExecution',
      startTime: 123
    })

    const completed = adapter.convertEventToMessageParts({
      method: 'item/completed',
      params: {
        item: { id: 'tool-1', type: 'commandExecution', output: 'ok' },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(completed[0]).toMatchObject({
      id: 'tool-tool-1',
      type: MessagePartType.TOOL,
      update: true,
      tool: { name: 'commandExecution', status: 'completed' }
    })
    expect(session.runningTools.has('tool-tool-1')).toBe(false)
  })

  it('stores command approval requests and responds with app-server decision shape', async () => {
    const adapterInstance = new CodexAppServerAdapter()
    const adapter = adapterPrivate(adapterInstance)
    const session = createSession()
    adapter.sessions.set('thread-1', session)

    adapter.handleRpcMessage(session, {
      jsonrpc: '2.0',
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'cmd-1',
        command: 'git status',
        reason: 'needs shell access',
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1
      }
    })

    expect(session.status).toBe(SessionStatusType.WAITING_APPROVAL)
    expect(session.pendingApproval).toMatchObject({
      requestId: 7,
      toolCallId: 'cmd-1',
      responseKind: 'commandExecution'
    })

    await adapterInstance.respondToApproval('thread-1', true)

    expect(session.process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, result: { decision: 'accept' } })}\n`
    )
    expect(session.pendingApproval).toBeNull()
  })

  it('preserves app-server approval decisions when provided', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()

    adapter.handleRpcMessage(session, {
      jsonrpc: '2.0',
      id: 8,
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'cmd-2',
        command: 'curl https://example.com',
        availableDecisions: ['acceptForSession', 'decline', 'cancel'],
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1
      }
    })

    expect(session.pendingApproval).toMatchObject({
      options: [
        { optionId: 'acceptForSession', name: 'Allow for Session', kind: 'allow' },
        { optionId: 'decline', name: 'Deny', kind: 'reject' },
        { optionId: 'cancel', name: 'Deny and Stop', kind: 'reject' }
      ]
    })
  })

  it('auto-approves MCP elicitation requests with app-server action shape', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    session.config.permissionMode = 'allow'

    adapter.handleRpcMessage(session, {
      jsonrpc: '2.0',
      id: 9,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        message: 'Need input'
      }
    })

    expect(session.process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ jsonrpc: '2.0', id: 9, result: { action: 'accept', content: {} } })}\n`
    )
  })

  it('passes configured sandbox mode to app-server turn start', async () => {
    const adapterInstance = new CodexAppServerAdapter()
    const adapter = adapterPrivate(adapterInstance)
    const session = createSession()
    adapter.sessions.set('thread-1', session)
    const sendRpcRequest = vi.fn().mockResolvedValue({ turnId: 'turn-1' })
    adapter.sendRpcRequest = sendRpcRequest

    await adapterInstance.sendPrompt('thread-1', [{ type: MessagePartType.TEXT, text: 'hello' }], {
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceDir: '/tmp/workspace',
      sandboxMode: 'danger-full-access'
    })

    expect(sendRpcRequest).toHaveBeenCalledWith(session, 'turn/start', expect.objectContaining({
      sandbox: 'danger-full-access'
    }))
  })

  it('converts command output deltas into updating tool parts', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const lengths = new Map<string, string>()

    const first = adapter.convertEventToMessageParts({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'cmd-1', delta: 'line 1\n' }
    }, seenMessageIds, seenPartIds, lengths, session)
    const second = adapter.convertEventToMessageParts({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'cmd-1', delta: 'line 2\n' }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(first[0]).toMatchObject({
      id: 'tool-cmd-1',
      type: MessagePartType.TOOL,
      update: false,
      tool: { name: 'command', status: 'running', output: 'line 1\n' }
    })
    expect(second[0]).toMatchObject({
      id: 'tool-cmd-1',
      type: MessagePartType.TOOL,
      update: true,
      tool: { name: 'command', status: 'running', output: 'line 1\nline 2\n' }
    })
  })

  it('serializes and caps command tool payloads before IPC delivery', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const lengths = new Map<string, string>()

    const parts = adapter.convertEventToMessageParts({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-large',
          type: 'commandExecution',
          command: 'yes',
          output: 'x'.repeat(120_000)
        },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(parts[0].tool?.input).toEqual(expect.any(String))
    expect(parts[0].tool?.output).toEqual(expect.any(String))
    expect((parts[0].tool?.output as string).length).toBeLessThan(101_000)
    expect(parts[0].tool?.output as string).toContain('truncated for display')
  })

  it('uses server and tool names for app-server MCP tool calls', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const lengths = new Map<string, string>()

    const parts = adapter.convertEventToMessageParts({
      method: 'item/completed',
      params: {
        item: {
          type: 'mcpToolCall',
          id: 'call-1',
          server: 'Carousell_MCP',
          tool: 'workflow_get_node_parameter',
          status: 'completed',
          arguments: { workflowId: 'wf-1' },
          result: { content: [{ type: 'text', text: 'ok' }] }
        },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(parts[0]).toMatchObject({
      id: 'tool-call-1',
      type: MessagePartType.TOOL,
      tool: {
        name: 'Carousell_MCP.workflow_get_node_parameter',
        title: 'Carousell_MCP.workflow_get_node_parameter',
        status: 'completed'
      }
    })
  })

  it('uses changed file names for app-server file change tool titles', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const lengths = new Map<string, string>()

    const parts = adapter.convertEventToMessageParts({
      method: 'item/completed',
      params: {
        item: {
          type: 'fileChange',
          id: 'call-2',
          changes: [{
            path: '/tmp/workspace/src/renderer/src/components/agents/AgentTranscriptPanel.tsx',
            kind: { type: 'modify' }
          }],
          status: 'completed'
        },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(parts[0]).toMatchObject({
      id: 'tool-call-2',
      type: MessagePartType.TOOL,
      tool: {
        name: 'fileChange',
        title: 'AgentTranscriptPanel.tsx',
        status: 'completed'
      }
    })
  })

  it('uses command text for app-server command execution tool titles', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const session = createSession()
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const lengths = new Map<string, string>()

    const parts = adapter.convertEventToMessageParts({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'call-3',
          command: '/bin/zsh -lc "rg fallback"',
          commandActions: [{
            type: 'search',
            command: 'rg -n "mcpToolCall" src/main/adapters',
            query: 'mcpToolCall',
            path: 'adapters'
          }],
          status: 'completed'
        },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    }, seenMessageIds, seenPartIds, lengths, session)

    expect(parts[0]).toMatchObject({
      id: 'tool-call-3',
      type: MessagePartType.TOOL,
      tool: {
        name: 'commandExecution',
        title: 'rg -n "mcpToolCall" src/main/adapters',
        status: 'completed'
      }
    })
  })

  it('converts 20x MCP configs to codex app-server config shape', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())

    const config = adapter.buildConfigOverrides({
      workspaceDir: '/tmp/workspace',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: 'secret' }
        },
        'Carousell MCP': {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' }
        }
      }
    })

    expect(config).toEqual({
      model_reasoning_effort: 'high',
      sandbox_workspace_write: {
        network_access: true,
        writable_roots: ['/tmp/workspace']
      },
      mcp_servers: {
        local: {
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: 'secret' }
        },
        Carousell_MCP: {
          url: 'https://example.com/mcp',
          http_headers: { Authorization: 'Bearer token' }
        }
      }
    })
  })

  it('clears stale live buffer before sending a new prompt', async () => {
    const adapterInstance = new CodexAppServerAdapter()
    const adapter = adapterPrivate(adapterInstance)
    const session = createSession()
    adapter.sessions.set('thread-1', session)
    session.messageBuffer.push({ method: 'item/agentMessage/delta', params: { itemId: 'stale', delta: 'stale' } })
    session.pendingRequests.set(1, { resolve: vi.fn(), reject: vi.fn() })

    const sendPromise = adapterInstance.sendPrompt('thread-1', [{ type: MessagePartType.TEXT, text: 'hello' }], {
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceDir: '/tmp/workspace'
    })
    const pending = session.pendingRequests.get(1)
    expect(pending).toBeTruthy()
    pending?.resolve({ turnId: 'turn-1' })
    await sendPromise

    expect(session.messageBuffer).toHaveLength(1)
    expect(session.messageBuffer[0]).toMatchObject({
      method: 'item/completed',
      params: { item: { type: 'user_message', text: 'hello' } }
    })
  })

  it('strips ambient OpenAI keys for subscription auth and preserves explicit API-key mode', () => {
    const adapter = adapterPrivate(new CodexAppServerAdapter())
    const originalOpenAI = process.env.OPENAI_API_KEY
    const originalCodex = process.env.CODEX_API_KEY
    process.env.OPENAI_API_KEY = 'ambient-openai'
    process.env.CODEX_API_KEY = 'ambient-codex'

    try {
      const subscriptionEnv = adapter.buildEnvironment({
        authMethod: 'subscription',
        secretEnvVars: { OPENAI_API_KEY: 'secret-openai' }
      })
      expect(subscriptionEnv.usesApiKey).toBe(false)
      expect(subscriptionEnv.env.OPENAI_API_KEY).toBeUndefined()
      expect(subscriptionEnv.env.CODEX_API_KEY).toBeUndefined()

      const apiKeyEnv = adapter.buildEnvironment({
        authMethod: 'api_key',
        apiKeys: { openai: 'explicit-key' },
        secretEnvVars: { CUSTOM_SECRET: 'secret' }
      })
      expect(apiKeyEnv.usesApiKey).toBe(true)
      expect(apiKeyEnv.env.OPENAI_API_KEY).toBe('explicit-key')
      expect(apiKeyEnv.env.CODEX_API_KEY).toBe('explicit-key')
      expect(apiKeyEnv.env.CUSTOM_SECRET).toBe('secret')
      expect(apiKeyEnv.env.NO_BROWSER).toBe('1')
      expect(apiKeyEnv.env.CODEX_HOME).toContain('codex-app-server-session-')
    } finally {
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalOpenAI
      if (originalCodex === undefined) delete process.env.CODEX_API_KEY
      else process.env.CODEX_API_KEY = originalCodex
    }
  })
})
