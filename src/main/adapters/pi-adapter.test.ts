/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'events'
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
    textByBlock: new Map(),
    reasoningByBlock: new Map(),
    toolParts: new Map(),
    pendingUiRequests: new Map(),
    turn: 1,
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
    await adapter.respondToQuestion(session.id, { Environment: 'Stage' }, session.config)
    expect(process.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'extension_ui_response', id: 'request-2', value: 'Stage' })}\n`,
      expect.any(Function),
    )
  })
})
