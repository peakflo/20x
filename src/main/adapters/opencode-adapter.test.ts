import { afterEach, describe, it, expect, vi } from 'vitest'
import { OpencodeAdapter } from './opencode-adapter'
import { SessionStatusType } from './coding-agent-adapter'
import { ENTERPRISE_AI_GATEWAY_PROVIDER_ID } from '../enterprise-ai-gateway'

import * as enterpriseAiGateway from '../enterprise-ai-gateway'

describe('OpencodeAdapter', () => {
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
})
