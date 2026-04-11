import { describe, it, expect, vi } from 'vitest'
import { OpencodeAdapter } from './opencode-adapter'
import { SessionStatusType } from './coding-agent-adapter'

describe('OpencodeAdapter', () => {
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
