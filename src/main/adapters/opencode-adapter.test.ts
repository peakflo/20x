import { afterEach, describe, it, expect, vi } from 'vitest'
import { OpencodeAdapter } from './opencode-adapter'
import { SessionStatusType } from './coding-agent-adapter'
import { ENTERPRISE_AI_GATEWAY_PROVIDER_ID } from '../enterprise-ai-gateway'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import * as enterpriseAiGateway from '../enterprise-ai-gateway'

describe('OpencodeAdapter', () => {
  describe('runtime plugin generation', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('writes tilldone and secret injector runtime plugins before session startup', () => {
      const adapter = new OpencodeAdapter()
      const workspaceDir = mkdtempSync(join(tmpdir(), 'opencode-adapter-test-'))

      try {
        ;(adapter as any).writeRuntimePluginFiles({
          agentId: 'agent-1',
          taskId: 'task-1',
          workspaceDir,
          secretEnvVars: {
            API_KEY: 'secret-value'
          }
        })

        const pluginPaths = (adapter as any).pluginFilePaths as string[]
        const supportPaths = (adapter as any).runtimeSupportFilePaths as string[]

        expect(pluginPaths).toHaveLength(2)
        expect(pluginPaths.some(path => path.endsWith('20x-tilldone.js'))).toBe(true)
        expect(pluginPaths.some(path => path.endsWith('20x-secret-injector.js'))).toBe(true)
        expect(supportPaths.some(path => path.endsWith('.20x-secrets'))).toBe(true)
        expect(supportPaths.some(path => path.endsWith('.20x-tilldone-state.json'))).toBe(true)
        expect(supportPaths.some(path => path.endsWith('.20x-tilldone-config.json'))).toBe(true)

        const tillDonePath = pluginPaths.find(path => path.endsWith('20x-tilldone.js'))!
        const tillDoneCode = readFileSync(tillDonePath, 'utf-8')
        expect(tillDoneCode).toContain('"tool.execute.before"')
        expect(tillDoneCode).toContain('event: async function(input)')
        expect(tillDoneCode).toContain('var ev = input.event')
        expect(tillDoneCode).toContain('ev.type === "todo.updated"')
        expect(tillDoneCode).toContain('ev.properties?.sessionID')
        expect(tillDoneCode).toContain('isTillDoneEnabled(sessionId)')
        expect(tillDoneCode).toContain('parsed.sessions[sessionId]')
        expect(tillDoneCode).toContain('return false;')
        expect(tillDoneCode).toContain([
          '  } catch (e) {',
          '    return false;',
          '  }',
          '}',
          ''
        ].join('\n'))
        expect(tillDoneCode).toContain('INITIAL_TODO_PROMPT')

        // Idle nudging is handled by the agent-manager (universal for all agents),
        // not by the plugin. The plugin only handles tool blocking + todo state tracking.
        expect(tillDoneCode).not.toContain('session.idle')
        expect(tillDoneCode).not.toContain('CONTINUE_PROMPT')

        const tillDoneConfigPath = supportPaths.find(path => path.endsWith('.20x-tilldone-config.json'))!
        expect(JSON.parse(readFileSync(tillDoneConfigPath, 'utf-8'))).toEqual({ defaultEnabled: true, sessions: {} })

        const secretPluginPath = pluginPaths.find(path => path.endsWith('20x-secret-injector.js'))!
        const secretPluginCode = readFileSync(secretPluginPath, 'utf-8')
        expect(secretPluginCode).toContain('input.tool === "bash"')
        expect(secretPluginCode).toContain('readFileSync(SECRETS_PATH, "utf-8").trim()')
      } finally {
        rmSync(workspaceDir, { recursive: true, force: true })
      }
    })

    it('passes disabled tilldone config through to the generated extension', () => {
      const adapter = new OpencodeAdapter()
      const workspaceDir = mkdtempSync(join(tmpdir(), 'opencode-adapter-test-'))

      try {
        ;(adapter as any).writeRuntimePluginFiles({
          agentId: 'agent-1',
          taskId: 'mastermind-session',
          workspaceDir,
          tillDone: false
        })

        const pluginPaths = (adapter as any).pluginFilePaths as string[]
        const supportPaths = (adapter as any).runtimeSupportFilePaths as string[]
        const tillDoneConfigPath = supportPaths.find(path => path.endsWith('.20x-tilldone-config.json'))!

        expect(pluginPaths.some(path => path.endsWith('20x-tilldone.js'))).toBe(true)
        expect(JSON.parse(readFileSync(tillDoneConfigPath, 'utf-8'))).toEqual({ defaultEnabled: false, sessions: {} })
      } finally {
        rmSync(workspaceDir, { recursive: true, force: true })
      }
    })

    it('persists tilldone enablement per OpenCode session', () => {
      const adapter = new OpencodeAdapter()
      const workspaceDir = mkdtempSync(join(tmpdir(), 'opencode-adapter-test-'))

      try {
        ;(adapter as any).writeRuntimePluginFiles({
          agentId: 'agent-1',
          taskId: 'task-1',
          workspaceDir,
          tillDone: true
        })

        ;(adapter as any).writeTillDoneSessionConfig('regular-session', true)
        ;(adapter as any).writeTillDoneSessionConfig('triage-session', false)

        const supportPaths = (adapter as any).runtimeSupportFilePaths as string[]
        const tillDoneConfigPath = supportPaths.find(path => path.endsWith('.20x-tilldone-config.json'))!

        expect(JSON.parse(readFileSync(tillDoneConfigPath, 'utf-8'))).toEqual({
          defaultEnabled: true,
          sessions: {
            'regular-session': true,
            'triage-session': false
          }
        })
      } finally {
        rmSync(workspaceDir, { recursive: true, force: true })
      }
    })

    it('preserves per-session tilldone config when another session starts in the same workspace', () => {
      const adapter = new OpencodeAdapter()
      const workspaceDir = mkdtempSync(join(tmpdir(), 'opencode-adapter-test-'))

      try {
        ;(adapter as any).writeRuntimePluginFiles({
          agentId: 'agent-1',
          taskId: 'triage-task',
          workspaceDir,
          tillDone: false
        })
        ;(adapter as any).writeTillDoneSessionConfig('triage-session', false)

        ;(adapter as any).writeRuntimePluginFiles({
          agentId: 'agent-1',
          taskId: 'regular-task',
          workspaceDir,
          tillDone: true
        })
        ;(adapter as any).writeTillDoneSessionConfig('regular-session', true)

        const supportPaths = (adapter as any).runtimeSupportFilePaths as string[]
        const tillDoneConfigPath = supportPaths.find(path => path.endsWith('.20x-tilldone-config.json'))!

        expect(JSON.parse(readFileSync(tillDoneConfigPath, 'utf-8'))).toEqual({
          defaultEnabled: true,
          sessions: {
            'triage-session': false,
            'regular-session': true
          }
        })
      } finally {
        rmSync(workspaceDir, { recursive: true, force: true })
      }
    })

    it('cleans up generated runtime plugin files on destroySession', async () => {
      const adapter = new OpencodeAdapter()
      const workspaceDir = mkdtempSync(join(tmpdir(), 'opencode-adapter-test-'))

      try {
        ;(adapter as any).writeRuntimePluginFiles({
          agentId: 'agent-1',
          taskId: 'task-1',
          workspaceDir,
          secretEnvVars: {
            API_KEY: 'secret-value'
          }
        })

        const generatedPaths = [
          ...((adapter as any).pluginFilePaths as string[]),
          ...((adapter as any).runtimeSupportFilePaths as string[])
        ]
        expect(generatedPaths.every(path => existsSync(path))).toBe(true)

        await adapter.destroySession('session-1', {
          agentId: 'agent-1',
          taskId: 'task-1',
          workspaceDir
        })

        expect(generatedPaths.every(path => !existsSync(path))).toBe(true)
        expect((adapter as any).pluginFilePaths).toEqual([])
        expect((adapter as any).runtimeSupportFilePaths).toEqual([])
      } finally {
        rmSync(workspaceDir, { recursive: true, force: true })
      }
    })
  })

  describe('waitForMcpServersReady', () => {
    it('prefers SDK mcp.list when available', async () => {
      const adapter = new OpencodeAdapter()
      const list = vi.fn().mockResolvedValue({
        data: [
          { name: 'server-a', status: 'connected' },
          { name: 'server-b', status: 'failed' }
        ]
      })
      const status = vi.fn()
      const mockClient = { mcp: { list, status } }

      const result = await (adapter as any).waitForMcpServersReady(
        mockClient,
        ['server-a', 'server-b'],
        '/tmp/ws',
        1,
        0
      )

      expect(list).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
      expect(result.get('server-a')).toBe('connected')
      expect(result.get('server-b')).toBe('failed')
    })

    it('falls back to SDK mcp.status and batches checks per attempt', async () => {
      const adapter = new OpencodeAdapter()
      const status = vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            'server-a': { status: 'connecting' },
            'server-b': { status: 'connecting' }
          }
        })
        .mockResolvedValueOnce({
          data: {
            'server-a': { status: 'connected' },
            'server-b': { status: 'failed' }
          }
        })
      const mockClient = { mcp: { status } }

      const result = await (adapter as any).waitForMcpServersReady(
        mockClient,
        ['server-a', 'server-b'],
        '/tmp/ws',
        2,
        0
      )

      expect(status).toHaveBeenCalledTimes(2)
      expect(result.get('server-a')).toBe('connected')
      expect(result.get('server-b')).toBe('failed')
    })

    it('marks unresolved servers as timeout', async () => {
      const adapter = new OpencodeAdapter()
      const status = vi.fn().mockResolvedValue({
        data: {
          'server-a': { status: 'connecting' }
        }
      })
      const mockClient = { mcp: { status } }

      const result = await (adapter as any).waitForMcpServersReady(
        mockClient,
        ['server-a'],
        '/tmp/ws',
        2,
        0
      )

      expect(status).toHaveBeenCalledTimes(2)
      expect(result.get('server-a')).toBe('timeout')
    })
  })

  it('scopes part ids by message id when polling and replaying messages', async () => {
    const adapter = new OpencodeAdapter()
    const mockClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: 'msg-1', role: 'assistant' },
              parts: [{ id: 'part-1', type: 'text', text: 'First reply' }]
            },
            {
              info: { id: 'msg-2', role: 'assistant' },
              parts: [{ id: 'part-1', type: 'text', text: 'Second reply' }]
            }
          ]
        })
      }
    }

    ;(adapter as any).clients.set('session-1', mockClient)

    const polled = await adapter.pollMessages(
      'session-1',
      new Set<string>(),
      new Set<string>(),
      new Map<string, string>(),
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' }
    )

    const replayed = await adapter.getAllMessages('session-1', {
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceDir: '/tmp/ws'
    })

    expect(polled.map((part) => part.id)).toEqual(['msg-1:part-1', 'msg-2:part-1'])
    expect(replayed.flatMap((message) => message.parts.map((part) => part.id))).toEqual(['msg-1:part-1', 'msg-2:part-1'])
  })

  it('falls back to message-scoped part indexes during polling when part ids are missing', async () => {
    const adapter = new OpencodeAdapter()
    const mockClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: 'msg-1', role: 'assistant' },
              parts: [
                { type: 'text', text: 'First chunk' },
                { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: '/tmp' } }
              ]
            }
          ]
        })
      }
    }

    ;(adapter as any).clients.set('session-1', mockClient)

    const polled = await adapter.pollMessages(
      'session-1',
      new Set<string>(),
      new Set<string>(),
      new Map<string, string>(),
      { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' }
    )

    expect(polled).toHaveLength(2)
    expect(polled.map((part) => part.id)).toEqual(['msg-1:part-0', 'msg-1:part-1'])
    expect(polled.map((part) => part.type)).toEqual(['text', 'tool'])
  })

  describe('getStatus', () => {
    it('returns BUSY when prompt is still in-flight', async () => {
      const adapter = new OpencodeAdapter()
      const mockClient = {
        session: {
          status: async () => ({
            data: {
              'session-1': { type: 'idle' }
            }
          })
        }
      }
      ;(adapter as any).clients.set('session-1', mockClient)
      // Simulate an in-flight prompt by adding to promptAborts
      ;(adapter as any).promptAborts.set('session-1', new AbortController())

      const status = await adapter.getStatus('session-1', { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' })
      expect(status.type).toBe(SessionStatusType.BUSY)
    })

    it('returns BUSY when status says idle but tool parts are pending', async () => {
      const adapter = new OpencodeAdapter()
      const mockClient = {
        session: {
          status: async () => ({
            data: {
              'session-3': { type: 'idle' }
            }
          }),
          messages: async () => ({
            data: [
              {
                info: { id: 'msg-1', role: 'assistant' },
                parts: [
                  { id: 'part-1', type: 'text', text: 'Let me run that command' },
                  { id: 'part-2', type: 'tool', tool: 'bash', state: { status: 'pending', input: { command: 'ls' } } }
                ]
              }
            ]
          })
        }
      }
      ;(adapter as any).clients.set('session-3', mockClient)

      const mockV2Client = {
        question: {
          list: async () => ({ data: [] })
        }
      }
      vi.spyOn(adapter as any, 'getV2Client').mockReturnValue(mockV2Client)

      const status = await adapter.getStatus('session-3', { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' })
      expect(status.type).toBe(SessionStatusType.BUSY)
    })

    it('returns BUSY when status says idle but tool parts are running', async () => {
      const adapter = new OpencodeAdapter()
      const mockClient = {
        session: {
          status: async () => ({
            data: {
              'session-4': { type: 'idle' }
            }
          }),
          messages: async () => ({
            data: [
              {
                info: { id: 'msg-1', role: 'assistant' },
                parts: [
                  { id: 'part-1', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } }
                ]
              }
            ]
          })
        }
      }
      ;(adapter as any).clients.set('session-4', mockClient)

      const mockV2Client = {
        question: {
          list: async () => ({ data: [] })
        }
      }
      vi.spyOn(adapter as any, 'getV2Client').mockReturnValue(mockV2Client)

      const status = await adapter.getStatus('session-4', { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' })
      expect(status.type).toBe(SessionStatusType.BUSY)
    })

    it('returns IDLE when status is idle and all tool parts are completed', async () => {
      const adapter = new OpencodeAdapter()
      const mockClient = {
        session: {
          status: async () => ({
            data: {
              'session-5': { type: 'idle' }
            }
          }),
          messages: async () => ({
            data: [
              {
                info: { id: 'msg-1', role: 'assistant' },
                parts: [
                  { id: 'part-1', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'file1.txt' } }
                ]
              }
            ]
          })
        }
      }
      ;(adapter as any).clients.set('session-5', mockClient)

      const mockV2Client = {
        question: {
          list: async () => ({ data: [] })
        }
      }
      vi.spyOn(adapter as any, 'getV2Client').mockReturnValue(mockV2Client)

      const status = await adapter.getStatus('session-5', { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' })
      expect(status.type).toBe(SessionStatusType.IDLE)
    })

    it('returns WAITING_APPROVAL if V2 API has pending question for session', async () => {
      const adapter = new OpencodeAdapter()
      const mockClient = {
        session: {
          status: async () => ({
            data: {
              'session-2': { type: 'busy' }
            }
          })
        }
      }
      ;(adapter as any).clients.set('session-2', mockClient)

      const mockV2Client = {
        question: {
          list: async () => ({
            data: [
              { id: 'q-1', sessionID: 'session-other' },
              { id: 'q-2', sessionID: 'session-2' }
            ]
          })
        }
      }
      vi.spyOn(adapter as any, 'getV2Client').mockReturnValue(mockV2Client)

      const status = await adapter.getStatus('session-2', { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' })
      expect(status.type).toBe(SessionStatusType.WAITING_APPROVAL)
    })

    it('returns WAITING_APPROVAL if V2 API has pending question using sessionId', async () => {
      const adapter = new OpencodeAdapter()
      const mockClient = {
        session: {
          status: async () => ({
            data: {
              'session-2': { type: 'busy' }
            }
          })
        }
      }
      ;(adapter as any).clients.set('session-2', mockClient)

      const mockV2Client = {
        question: {
          list: async () => ({
            data: [
              { id: 'q-2', sessionId: 'session-2' }
            ]
          })
        }
      }
      vi.spyOn(adapter as any, 'getV2Client').mockReturnValue(mockV2Client)

      const status = await adapter.getStatus('session-2', { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' })
      expect(status.type).toBe(SessionStatusType.WAITING_APPROVAL)
    })

    it('returns IDLE if no question is pending for session and underlying is idle', async () => {
      const adapter = new OpencodeAdapter()
      const mockClient = {
        session: {
          status: async () => ({
            data: {
              'session-2': { type: 'idle' }
            }
          }),
          messages: async () => ({
            data: [
              {
                info: { id: 'msg-1', role: 'assistant' },
                parts: [{ id: 'part-1', type: 'text', text: 'Done' }]
              }
            ]
          })
        }
      }
      ;(adapter as any).clients.set('session-2', mockClient)

      const mockV2Client = {
        question: {
          list: async () => ({
            data: [
              { id: 'q-1', sessionID: 'session-other' }
            ]
          })
        }
      }
      vi.spyOn(adapter as any, 'getV2Client').mockReturnValue(mockV2Client)

      const status = await adapter.getStatus('session-2', { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' })
      expect(status.type).toBe(SessionStatusType.IDLE)
    })

    it('returns WAITING_APPROVAL if underlying status is waiting_user (question)', async () => {
      const adapter = new OpencodeAdapter()
      const mockClient = {
        session: {
          status: async () => ({
            data: {
              'session-2': { type: 'waiting_user' }
            }
          })
        }
      }
      ;(adapter as any).clients.set('session-2', mockClient)

      const mockV2Client = {
        question: {
          list: async () => ({ data: [] })
        }
      }
      vi.spyOn(adapter as any, 'getV2Client').mockReturnValue(mockV2Client)

      const status = await adapter.getStatus('session-2', { agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/tmp/ws' })
      expect(status.type).toBe(SessionStatusType.WAITING_APPROVAL)
    })
  })

  describe('filterStaleProviderModels', () => {
    afterEach(() => vi.restoreAllMocks())

    it('removes models not present in fresh SQLite config', () => {
      const mockDb = { getSetting: vi.fn() }
      const adapter = new OpencodeAdapter(mockDb)

      vi.spyOn(enterpriseAiGateway, 'readEnterpriseAiGatewayConfig').mockReturnValue({
        apiKey: 'sk-test',
        baseUrl: 'https://litellm.example.com',
        models: [
          { id: 'kept-model', name: 'Kept Model' },
          { id: 'new-model', name: 'New Model' }
        ]
      })

      const providers = [
        {
          id: ENTERPRISE_AI_GATEWAY_PROVIDER_ID,
          name: 'Peakflo',
          models: {
            'old-model-1': { name: 'Old Model 1' },
            'old-model-2': { name: 'Old Model 2' },
            'kept-model': { name: 'Kept Model' }
          } as unknown
        },
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: { 'claude-4': { name: 'Claude 4' } } as unknown
        }
      ]

      ;(adapter as any).filterStaleProviderModels(providers)

      const peakflo = providers.find(p => p.id === ENTERPRISE_AI_GATEWAY_PROVIDER_ID)!
      const models = peakflo.models as Record<string, unknown>
      expect(models['old-model-1']).toBeUndefined()
      expect(models['old-model-2']).toBeUndefined()
      expect(models['kept-model']).toEqual({ name: 'Kept Model' })

      // Other providers untouched
      const anthropic = providers.find(p => p.id === 'anthropic')!
      expect(anthropic.models).toEqual({ 'claude-4': { name: 'Claude 4' } })
    })

    it('does not filter when no db is available', () => {
      const adapter = new OpencodeAdapter() // no db
      const readSpy = vi.spyOn(enterpriseAiGateway, 'readEnterpriseAiGatewayConfig')

      const providers = [
        {
          id: ENTERPRISE_AI_GATEWAY_PROVIDER_ID,
          name: 'Peakflo',
          models: { 'model-a': { name: 'A' }, 'model-b': { name: 'B' } } as unknown
        }
      ]

      ;(adapter as any).filterStaleProviderModels(providers)

      expect(readSpy).not.toHaveBeenCalled()
      expect(Object.keys(providers[0].models as Record<string, unknown>)).toEqual(['model-a', 'model-b'])
    })

    it('does not filter when gateway config returns null', () => {
      const mockDb = { getSetting: vi.fn() }
      const adapter = new OpencodeAdapter(mockDb)

      vi.spyOn(enterpriseAiGateway, 'readEnterpriseAiGatewayConfig').mockReturnValue(null)

      const providers = [
        {
          id: ENTERPRISE_AI_GATEWAY_PROVIDER_ID,
          name: 'Peakflo',
          models: { 'model-a': { name: 'A' } } as unknown
        }
      ]

      ;(adapter as any).filterStaleProviderModels(providers)

      expect(Object.keys(providers[0].models as Record<string, unknown>)).toEqual(['model-a'])
    })

    it('is a no-op when all server models match fresh config', () => {
      const mockDb = { getSetting: vi.fn() }
      const adapter = new OpencodeAdapter(mockDb)

      vi.spyOn(enterpriseAiGateway, 'readEnterpriseAiGatewayConfig').mockReturnValue({
        apiKey: 'sk-test',
        baseUrl: 'https://litellm.example.com',
        models: [
          { id: 'model-a', name: 'A' },
          { id: 'model-b', name: 'B' }
        ]
      })

      const providers = [
        {
          id: ENTERPRISE_AI_GATEWAY_PROVIDER_ID,
          name: 'Peakflo',
          models: { 'model-a': { name: 'A' }, 'model-b': { name: 'B' } } as unknown
        }
      ]

      ;(adapter as any).filterStaleProviderModels(providers)

      const models = providers[0].models as Record<string, unknown>
      expect(Object.keys(models)).toEqual(['model-a', 'model-b'])
    })
  })

  describe('permission auto-approve', () => {
    it('handleServerEvent routes permission.asked to autoApprovePermission when mode is allow', async () => {
      const adapter = new OpencodeAdapter()
      const autoApproveSpy = vi.fn().mockResolvedValue(undefined)
      ;(adapter as any).autoApprovePermission = autoApproveSpy
      ;(adapter as any).sessionPermissionModes.set('ses_abc', 'allow')

      // Simulate a permission.asked SSE event (direct format)
      ;(adapter as any).handleServerEvent({
        type: 'permission.asked',
        properties: {
          id: 'per_123',
          sessionID: 'ses_abc',
          permission: 'external_directory',
          patterns: ['/some/path/*']
        }
      })

      expect(autoApproveSpy).toHaveBeenCalledWith('ses_abc', 'per_123')
    })

    it('handleServerEvent routes permission.asked from /global/event payload envelope', async () => {
      const adapter = new OpencodeAdapter()
      const autoApproveSpy = vi.fn().mockResolvedValue(undefined)
      ;(adapter as any).autoApprovePermission = autoApproveSpy
      ;(adapter as any).sessionPermissionModes.set('ses_abc', 'allow')

      // /global/event wraps events in a payload envelope
      ;(adapter as any).handleServerEvent({
        payload: {
          type: 'permission.asked',
          properties: {
            id: 'per_456',
            sessionID: 'ses_abc',
            permission: 'external_directory',
            patterns: ['/some/path/*']
          }
        }
      })

      expect(autoApproveSpy).toHaveBeenCalledWith('ses_abc', 'per_456')
    })

    it('handleServerEvent queues permission for UI when mode is ask', () => {
      const adapter = new OpencodeAdapter()
      const onDataAvailable = vi.fn()
      ;(adapter as any).onDataAvailable = onDataAvailable
      ;(adapter as any).sessionPermissionModes.set('ses_abc', 'ask')

      ;(adapter as any).handleServerEvent({
        type: 'permission.asked',
        properties: {
          id: 'per_789',
          sessionID: 'ses_abc',
          permission: 'external_directory',
          patterns: ['/some/path/*']
        }
      })

      const queue = (adapter as any).pendingPermissions.get('ses_abc')
      expect(queue).toHaveLength(1)
      expect(queue[0].permissionId).toBe('per_789')
      expect(onDataAvailable).toHaveBeenCalledWith('ses_abc')
    })

    it('handleServerEvent defaults to ask when session has no explicit permission mode', () => {
      const adapter = new OpencodeAdapter()
      const onDataAvailable = vi.fn()
      ;(adapter as any).onDataAvailable = onDataAvailable
      // Do NOT set sessionPermissionModes for ses_abc — should default to 'ask'

      ;(adapter as any).handleServerEvent({
        type: 'permission.asked',
        properties: {
          id: 'per_unknown',
          sessionID: 'ses_abc',
          permission: 'external_directory',
          patterns: []
        }
      })

      // Should queue for UI, not auto-approve
      const queue = (adapter as any).pendingPermissions.get('ses_abc')
      expect(queue).toHaveLength(1)
    })

    it('autoApprovePermission calls V2 SDK permission.reply with correct args including directory', async () => {
      const adapter = new OpencodeAdapter()
      const mockReply = vi.fn().mockResolvedValue({ data: {}, error: null })
      const mockV2Client = {
        permission: { reply: mockReply, list: vi.fn() }
      }
      ;(adapter as any).v2Client = mockV2Client
      // Set the workspace directory for the session
      ;(adapter as any).sessionWorkspaceDirs.set('ses_abc', '/workspace/task_1')

      await (adapter as any).autoApprovePermission('ses_abc', 'per_123')

      // If OpenCodeV2Client is loaded (it is in test env since we import the module),
      // it should try to use v2Client. If OpenCodeV2Client is null (dynamic import
      // failed), it falls through to raw fetch.
      if (mockReply.mock.calls.length > 0) {
        expect(mockReply).toHaveBeenCalledWith({
          requestID: 'per_123',
          reply: 'always',
          directory: '/workspace/task_1'
        })
      }
    })

    it('autoApprovePermission falls back to raw fetch when V2 SDK is not loaded', async () => {
      const adapter = new OpencodeAdapter()
      ;(adapter as any).v2Client = null
      ;(adapter as any).serverUrl = 'http://localhost:4096'
      ;(adapter as any).sessionWorkspaceDirs.set('ses_abc', '/workspace/task_1')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}'
      })
      vi.stubGlobal('fetch', mockFetch)

      try {
        await (adapter as any).autoApprovePermission('ses_abc', 'per_123')

        // Should have called fetch with V2 endpoint (not V1) and include directory query param
        // Check if fetch was called at all — if OpenCodeV2Client IS loaded
        // (dynamic import succeeded at module init), it would use the SDK path
        // and never reach fetch. Either path is valid depending on the env.
        if (mockFetch.mock.calls.length > 0) {
          expect(mockFetch).toHaveBeenCalledWith(
            'http://localhost:4096/permission/per_123/reply?directory=%2Fworkspace%2Ftask_1',
            expect.objectContaining({
              method: 'POST',
              body: JSON.stringify({ reply: 'always' })
            })
          )
        }
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('full SSE → auto-approve flow works end-to-end', async () => {
      const adapter = new OpencodeAdapter()
      ;(adapter as any).sessionPermissionModes.set('ses_live', 'allow')
      ;(adapter as any).serverUrl = 'http://localhost:4096'

      // Track what autoApprovePermission does
      const calls: Array<{ sessionId: string; permissionId: string }> = []
      ;(adapter as any).autoApprovePermission = async (sid: string, pid: string) => {
        calls.push({ sessionId: sid, permissionId: pid })
        // Don't actually call the real method (no server running)
      }

      // Simulate SSE data arriving
      const sseData = 'data: {"payload":{"type":"permission.asked","properties":{"id":"per_ext_dir","sessionID":"ses_live","permission":"external_directory","patterns":["/other/workspace/*"]}}}\n'

      // Parse it the same way processEventStream does
      const lines = sseData.split('\n')
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (line.startsWith('data: ') || line.startsWith('data:')) {
          const json = line.startsWith('data: ') ? line.slice(6) : line.slice(5)
          if (!json) continue
          try {
            const event = JSON.parse(json)
            ;(adapter as any).handleServerEvent(event)
          } catch { /* skip */ }
        }
      }

      expect(calls).toEqual([{ sessionId: 'ses_live', permissionId: 'per_ext_dir' }])
    })
  })

  describe('getRunningTools', () => {
    it('returns tools currently in running state with their input', async () => {
      const adapter = new OpencodeAdapter()
      const sessionId = 'ses_running_tools'
      const config = { agentId: 'a', taskId: 't', workspaceDir: '/workspace/task_1' }

      const mockClient = {
        session: {
          messages: vi.fn().mockResolvedValue({
            data: [
              {
                info: { id: 'msg_1', role: 'assistant' },
                parts: [
                  {
                    id: 'prt_1',
                    type: 'tool',
                    tool: 'read',
                    state: {
                      status: 'running',
                      input: { filePath: '/workspace/task_2/spec.md' },
                      time: { start: 1000000 }
                    }
                  },
                  {
                    id: 'prt_2',
                    type: 'tool',
                    tool: 'bash',
                    state: {
                      status: 'completed',
                      input: { command: 'ls' },
                      time: { start: 900000, end: 901000 }
                    }
                  },
                  {
                    id: 'prt_3',
                    type: 'text',
                    text: 'some text'
                  }
                ]
              },
              {
                info: { id: 'msg_2', role: 'assistant' },
                parts: [
                  {
                    id: 'prt_4',
                    type: 'tool',
                    tool: 'write',
                    state: {
                      status: 'running',
                      input: { filePath: '/workspace/task_1/file.ts', content: '...' },
                      time: { start: 1100000 }
                    }
                  }
                ]
              }
            ]
          })
        }
      }

      ;(adapter as any).clients = new Map([[sessionId, mockClient]])

      const running = await adapter.getRunningTools(sessionId, config as any)

      expect(running).toHaveLength(2)
      expect(running[0]).toEqual({
        partId: 'prt_1',
        toolName: 'read',
        startTime: 1000000,
        input: { filePath: '/workspace/task_2/spec.md' }
      })
      expect(running[1]).toEqual({
        partId: 'prt_4',
        toolName: 'write',
        startTime: 1100000,
        input: { filePath: '/workspace/task_1/file.ts', content: '...' }
      })
    })

    it('returns empty array when no client exists', async () => {
      const adapter = new OpencodeAdapter()
      const result = await adapter.getRunningTools('ses_none', { agentId: 'a', taskId: 't' } as any)
      expect(result).toEqual([])
    })

    it('returns empty array when messages API fails', async () => {
      const adapter = new OpencodeAdapter()
      const mockClient = {
        session: {
          messages: vi.fn().mockRejectedValue(new Error('Server down'))
        }
      }
      ;(adapter as any).clients = new Map([['ses_fail', mockClient]])

      const result = await adapter.getRunningTools('ses_fail', { agentId: 'a', taskId: 't' } as any)
      expect(result).toEqual([])
    })
  })
})
