/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'events'
import { StringDecoder } from 'string_decoder'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('child_process', () => ({
  spawn: spawnMock,
  execFile: vi.fn(),
}))

vi.mock('../enterprise-ai-gateway', () => ({
  ENTERPRISE_AI_GATEWAY_PROVIDER_ID: 'peakflo',
  ENTERPRISE_AI_GATEWAY_PROVIDER_NAME: 'Peakflo',
  buildPiAiGatewayProviderConfig: vi.fn(() => ({})),
  readEnterpriseAiGatewayConfig: vi.fn(() => null),
}))

import { PiAdapter } from './pi-adapter'
import { MessagePartType } from './coding-agent-adapter'

function fakeProcess() {
  const process = new EventEmitter() as EventEmitter & Record<string, any>
  process.pid = 12345
  process.exitCode = null
  process.stdin = {
    writable: true,
    write: vi.fn((_value: string, callback?: (error?: Error | null) => void) => {
      callback?.(null)
      return true
    }),
  }
  process.stdout = new EventEmitter()
  process.stderr = new EventEmitter()
  process.kill = vi.fn(() => true)
  return process
}

function fakeSession(process = fakeProcess()): any {
  return {
    id: 'session-1',
    process,
    config: {
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceDir: '/workspace',
      permissionMode: 'ask',
    },
    status: 'busy',
    lastError: null,
    pending: new Map(),
    parts: [],
    allMessages: [],
    stdoutBuffer: '',
    stdoutDecoder: new StringDecoder('utf8'),
    textByBlock: new Map(),
    reasoningByBlock: new Map(),
    toolParts: new Map(),
    pendingUiRequests: new Map(),
    turn: 1,
    assistantMessageOrdinal: 0,
    pendingTurnError: null,
    pendingTurnErrorMonotonicTime: null,
    sawAgentActivity: true,
    promptMayBeCommandOnly: false,
    closing: false,
  }
}

describe('PiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the native Pi session file and applies model selection through RPC', async () => {
    const child = fakeProcess()
    spawnMock.mockReturnValue(child)
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    vi.spyOn(adapter as any, 'findPiExecutable').mockResolvedValue('/usr/local/bin/pi')
    vi.spyOn(adapter as any, 'installPeakfloGateway').mockReturnValue(null)
    vi.spyOn(adapter as any, 'buildMcpConfig').mockReturnValue(undefined)
    vi.spyOn(adapter as any, 'installPermissionExtension').mockReturnValue('/tmp/20x-permissions.ts')
    vi.spyOn(adapter as any, 'attachProcess').mockImplementation(() => undefined)
    const command = vi.spyOn(adapter as any, 'command')
      .mockResolvedValueOnce({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionFile: '/sessions/native-session.jsonl' },
      })
      .mockResolvedValueOnce({ type: 'response', command: 'set_model', success: true })

    const id = await adapter.createSession({
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceDir: '/workspace',
      model: 'peakflo/model-one',
      permissionMode: 'ask',
    })

    expect(id).toBe('/sessions/native-session.jsonl')
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--mode')
    expect(args).toContain('--extension')
    expect(args).not.toContain('--session-dir')
    expect(args).not.toContain('--provider')
    expect(args).not.toContain('--model')
    expect(command).toHaveBeenLastCalledWith(
      expect.anything(),
      { type: 'set_model', provider: 'peakflo', modelId: 'model-one' },
    )
  })

  it('discovers the effective Pi model catalog through RPC', async () => {
    const child = fakeProcess()
    spawnMock.mockReturnValue(child)
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    vi.spyOn(adapter as any, 'findPiExecutable').mockResolvedValue('/usr/local/bin/pi')
    vi.spyOn(adapter as any, 'installPeakfloGateway').mockReturnValue(null)
    vi.spyOn(adapter as any, 'attachProcess').mockImplementation(() => undefined)
    vi.spyOn(adapter as any, 'terminateProcess').mockResolvedValue(undefined)
    vi.spyOn(adapter as any, 'command')
      .mockResolvedValueOnce({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { model: { provider: 'peakflo', id: 'model-one' } },
      })
      .mockResolvedValueOnce({
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: {
          models: [
            { provider: 'peakflo', id: 'model-one', name: 'Model One' },
            { provider: 'openai', id: 'model-two', name: 'Model Two' },
          ],
        },
      })

    await expect(adapter.getProviders(undefined, '/workspace')).resolves.toEqual({
      providers: [
        { id: 'peakflo', name: 'Peakflo', models: [{ id: 'model-one', name: 'Model One' }] },
        { id: 'openai', name: 'openai', models: [{ id: 'model-two', name: 'Model Two' }] },
      ],
      default: { peakflo: 'model-one' },
    })
    expect(spawnMock.mock.calls[0][1]).toEqual(['--mode', 'rpc', '--no-session', '--approve'])
  })

  it('waits for agent_settled instead of agent_end', () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const session = fakeSession()

    ;(adapter as any).handleEvent(session, { type: 'agent_end' })
    expect(session.status).toBe('busy')

    ;(adapter as any).handleEvent(session, { type: 'agent_settled' })
    expect(session.status).toBe('idle')
  })

  it('steers an active Pi turn instead of queueing a follow-up', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    await adapter.sendPrompt(session.id, [{ type: MessagePartType.TEXT, text: 'Stop and do this instead' }], session.config)

    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'prompt',
        message: 'Stop and do this instead',
        streamingBehavior: 'steer',
      })}\n`,
      expect.any(Function),
    )
  })

  it('sends a normal prompt when Pi is idle', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const process = fakeProcess()
    const session = fakeSession(process)
    session.status = 'idle'
    ;(adapter as any).sessions.set(session.id, session)

    await adapter.sendPrompt(session.id, [{ type: MessagePartType.TEXT, text: 'Start work' }], session.config)

    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'prompt', message: 'Start work' })}\n`,
      expect.any(Function),
    )
  })

  it('routes Pi confirmation requests through the approval API', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'request-1',
      method: 'confirm',
      title: 'Allow bash?',
      message: 'Run a command',
    })

    expect(adapter.getPendingApproval(session.id)?.question).toContain('Run a command')
    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({
      type: 'waiting_approval',
      message: 'Pi is waiting for input',
    })

    await expect(adapter.respondToApproval(session.id, true)).resolves.toBe(true)
    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'extension_ui_response', id: 'request-1', confirmed: true })}\n`,
      expect.any(Function),
    )
    expect(adapter.getPendingApproval(session.id)).toBeNull()
    expect(session.parts.at(-1)).toMatchObject({
      id: 'question-request-1',
      type: 'question',
      update: true,
      tool: {
        name: 'permission',
        status: 'completed',
        requestId: 'request-1',
      },
    })
  })

  it('routes Pi select requests through structured questions', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'request-2',
      method: 'select',
      title: 'Environment',
      message: 'Select an environment',
      options: ['Stage', 'Production'],
    })

    expect(session.parts[0].tool.questions[0].options).toEqual([
      { label: 'Stage', description: 'Stage' },
      { label: 'Production', description: 'Production' },
    ])
    expect(session.parts[0].type).toBe('question')
    expect(session.parts[0].tool.requestId).toBe('request-2')
    await expect(
      adapter.respondToQuestion(session.id, { Environment: 'Stage' }, session.config, 'request-2'),
    ).resolves.toBe(true)
    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'extension_ui_response', id: 'request-2', value: 'Stage' })}\n`,
      expect.any(Function),
    )

    vi.mocked(process.stdin.write).mockClear()
    const staleResponse = await adapter.respondToQuestion(
      session.id,
      { Environment: 'Production' },
      session.config,
      'request-2',
    )
    expect(process.stdin.write).not.toHaveBeenCalled()
    expect(staleResponse).toMatchObject({
      handled: false,
      resolutionPart: {
        id: 'pi-question-request-2',
        update: true,
        tool: {
          name: 'question',
          status: 'cancelled',
        },
      },
    })
  })

  it('does not answer a newer confirmation with a stale request ID', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'current-request',
      method: 'confirm',
      title: 'Allow bash?',
      message: 'Run a command',
    })

    await expect(
      adapter.respondToApproval(session.id, true, 'approved', 'stale-request'),
    ).resolves.toBe(false)
    expect(process.stdin.write).not.toHaveBeenCalled()
    expect(adapter.getPendingApproval(session.id)?.requestId).toBe('current-request')
  })

  it('keeps UTF-8 JSONL frames intact across buffer boundaries', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)
    ;(adapter as any).attachProcess(session)

    const line = Buffer.from(`${JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ราคา €\u2028ok' },
    })}\n`)
    const euroByte = line.indexOf(Buffer.from('€'))
    process.stdout.emit('data', line.subarray(0, euroByte + 1))
    process.stdout.emit('data', line.subarray(euroByte + 1))

    await expect(adapter.pollMessages(session.id)).resolves.toEqual([
      expect.objectContaining({ text: 'ราคา €\u2028ok' }),
    ])
  })

  it('uses distinct stream IDs for separate assistant messages in one run', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, { type: 'message_start', message: { role: 'assistant' } })
    ;(adapter as any).handleEvent(session, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'First' },
    })
    ;(adapter as any).handleEvent(session, { type: 'message_start', message: { role: 'assistant' } })
    ;(adapter as any).handleEvent(session, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Second' },
    })

    const parts = await adapter.pollMessages(session.id)
    expect(parts.map((part) => part.id)).toEqual(['pi-text-1:1:0', 'pi-text-1:2:0'])
    expect(parts.map((part) => part.text)).toEqual(['First', 'Second'])
  })

  it('uses the completed assistant message as the authoritative text', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, { type: 'message_start', message: { role: 'assistant' } })
    ;(adapter as any).handleEvent(session, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Partial' },
    })
    ;(adapter as any).handleEvent(session, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Final text' }], stopReason: 'stop' },
    })

    expect((await adapter.pollMessages(session.id)).at(-1)).toMatchObject({
      id: 'pi-text-1:1:0',
      text: 'Final text',
      update: true,
    })
  })

  it('does not surface a transient model error when Pi retry succeeds', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Temporary overload' },
    })
    ;(adapter as any).handleEvent(session, { type: 'auto_retry_start' })
    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({ type: 'busy' })

    ;(adapter as any).handleEvent(session, { type: 'auto_retry_end', success: true })
    ;(adapter as any).handleEvent(session, { type: 'agent_settled' })
    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({ type: 'idle' })
    expect((await adapter.pollMessages(session.id)).some((part) => part.type === 'error')).toBe(false)
  })

  it('settles a terminal model error when Pi omits agent_settled', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)
    vi.spyOn(adapter as any, 'command').mockResolvedValue({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { isStreaming: false },
    })

    const monotonicSpy = vi.spyOn(performance, 'now').mockReturnValue(100)
    ;(adapter as any).handleEvent(session, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    })
    monotonicSpy.mockReturnValue(1_101)

    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({
      type: 'error',
      message: 'Provider unavailable',
    })
    expect((await adapter.pollMessages(session.id)).at(-1)).toMatchObject({
      id: 'pi-error-1',
      type: 'error',
      text: 'Provider unavailable',
    })
    monotonicSpy.mockRestore()
  })

  it('closes timed-out dialogs when the Pi run settles', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const process = fakeProcess()
    const session = fakeSession(process)
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'timed-request',
      method: 'input',
      title: 'Name',
      placeholder: 'Type a name',
      timeout: 10,
    })
    ;(adapter as any).handleEvent(session, { type: 'agent_settled' })

    expect(session.pendingUiRequests.size).toBe(0)
    expect((await adapter.pollMessages(session.id)).at(-1)).toMatchObject({
      id: 'pi-question-timed-request',
      type: 'question',
      tool: { name: 'question', status: 'cancelled', requestId: 'timed-request' },
    })
    await expect(adapter.getStatus(session.id, session.config)).resolves.toEqual({ type: 'idle' })
  })

  it('includes editor prefill in the structured question', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const session = fakeSession()
    ;(adapter as any).sessions.set(session.id, session)

    ;(adapter as any).handleEvent(session, {
      type: 'extension_ui_request',
      id: 'editor-request',
      method: 'editor',
      title: 'Edit release notes',
      prefill: 'Existing notes',
    })

    expect(session.parts[0].tool.questions[0].question).toContain('Current value:\nExisting notes')
  })

  it('clears queued messages and pending dialogs before aborting', async () => {
    const adapter = new PiAdapter({ getSetting: vi.fn(() => null) } as any)
    const process = fakeProcess()
    const session = fakeSession(process)
    session.pendingUiRequests.set('request-1', {
      id: 'request-1',
      method: 'confirm',
      title: 'Allow bash?',
      message: 'Run a command',
      options: [],
    })
    ;(adapter as any).sessions.set(session.id, session)
    const command = vi.spyOn(adapter as any, 'command').mockResolvedValue({
      type: 'response',
      command: 'abort',
      success: true,
    })

    await adapter.abortPrompt(session.id)

    expect(command.mock.calls.map((call) => call[1])).toEqual([
      { type: 'clear_queue' },
      { type: 'abort' },
    ])
    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'extension_ui_response', id: 'request-1', cancelled: true })}\n`,
      expect.any(Function),
    )
    expect(session.pendingUiRequests.size).toBe(0)
    expect(session.status).toBe('idle')
  })
})
