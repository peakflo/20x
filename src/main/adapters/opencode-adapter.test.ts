import { describe, it, expect, vi } from 'vitest'
import { OpencodeAdapter } from './opencode-adapter'
import { SessionStatusType } from './coding-agent-adapter'

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

    it('returns WAITING_APPROVAL if underlying status is waiting_user', async () => {
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
})
