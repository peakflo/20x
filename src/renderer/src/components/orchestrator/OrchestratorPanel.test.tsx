import { describe, it, expect, beforeEach, vi } from 'vitest'

const agentSessionApi = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
  stopByTaskId: vi.fn(async () => ({ success: true, sessionId: 'session-1' })),
  send: vi.fn(async () => ({ newSessionId: null })),
  respondToApproval: vi.fn(async () => undefined),
  resume: vi.fn(),
  getTranscriptSnapshot: vi.fn(async () => ({ parts: [], rev: 0 })),
}))
const settingsApi = vi.hoisted(() => ({
  get: vi.fn(async (_key: string) => null as string | null),
  set: vi.fn(async () => undefined),
}))
const agentApi = vi.hoisted(() => ({
  getAll: vi.fn(async () => [
    { id: 'default-agent', name: 'Claude', is_default: true },
    { id: 'other-agent', name: 'Codex', is_default: false },
  ]),
}))

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  agentApi,
  settingsApi,
  agentSessionApi,
}))

/**
 * The transcript is a large tree with its own IPC; this file is about the
 * session. Its send handler is captured so a test can send like a user.
 */
const composer = vi.hoisted(() => ({ send: null as ((text: string) => void) | null }))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({
  AgentTranscriptPanel: ({ onSend, messages }: { onSend?: (text: string) => void; messages: Array<{ id: string; content: string }> }) => {
    composer.send = onSend ?? null
    return <div>{messages.map(m => <p key={m.id}>{m.content}</p>)}</div>
  },
}))
vi.mock('./ResponsibilitiesPanel', () => ({
  ResponsibilitiesPanel: ({ onProjectChange }: { onProjectChange: (project: object) => void }) =>
    <button onClick={() => onProjectChange({ id: 'project-1', name: 'Project', root: '/tmp/project', agentId: 'other-agent' })}>Choose project</button>,
}))

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OrchestratorPanel } from './OrchestratorPanel'
import { useAgentStore } from '@/stores/agent-store'

/**
 * Mastermind starts before there is anything to say.
 *
 * The rule this file protects: warming creates a window in which a message can
 * arrive while the session is still coming up. A message sent in that window
 * must wait for the session, not be dropped.
 */

const MASTERMIND = 'mastermind-session'

/** Resolves `start` by hand, so the warm-up can be held mid-flight. */
function deferredStart(): { resolve: () => void } {
  let release!: () => void
  agentSessionApi.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ sessionId: 'session-1' })
      })
  )
  return { resolve: () => release() }
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAgentStore.setState({ sessions: new Map() })
  settingsApi.get.mockResolvedValue(null)
  agentSessionApi.start.mockResolvedValue({ sessionId: 'session-1' })
  agentSessionApi.stopByTaskId.mockResolvedValue({ success: true, sessionId: 'session-1' })
  composer.send = null
})

describe('OrchestratorPanel — warming the session', () => {
  it('rejects a message when startup fails so the composer can restore its draft', async () => {
    settingsApi.get.mockResolvedValue('false')
    agentSessionApi.start.mockRejectedValue(new Error('startup failed'))
    render(<OrchestratorPanel onClose={vi.fn()} />)
    await waitFor(() => expect(composer.send).toBeTypeOf('function'))
    await expect(composer.send!('/tmp/spec.md')).rejects.toThrow('Mastermind agent session did not start')
    expect(agentSessionApi.send).not.toHaveBeenCalled()
  })

  it('starts the default agent at launch, before any message', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })

    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    // skipInitialPrompt: the agent must stay quiet until the user speaks.
    expect(agentSessionApi.start).toHaveBeenCalledWith('default-agent', MASTERMIND, undefined, true)
    expect(agentSessionApi.send).not.toHaveBeenCalled()
  })

  it('does not start anything when the preference is off', async () => {
    settingsApi.get.mockResolvedValue('false')
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(agentSessionApi.start).not.toHaveBeenCalled()
  })

  it('leaves the agent choice open while the session is only warm', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())

    // Warm is not a conversation: locking here would make the agent
    // unchangeable from the moment the app opens.
    expect(screen.getByRole('combobox')).not.toBeDisabled()
  })

  it('switches agents after a conversation starts, keeping visible history and the next message', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())

    await act(async () => {
      useAgentStore.setState((state) => {
        const sessions = new Map(state.sessions)
        const current = sessions.get(MASTERMIND) as Record<string, unknown> | undefined
        sessions.set(MASTERMIND, {
          ...current,
          status: 'waiting_approval',
          messages: [{ id: 'm1', role: 'user', content: 'hello' }, { id: 'q1', role: 'assistant', content: 'Old question', partType: 'question', tool: { questions: [{ question: 'Continue?' }] } }],
        } as never)
        return { sessions }
      })
    })

    expect(screen.getByText('hello')).toBeVisible()
    const selector = screen.getByRole('combobox', { name: 'Mastermind agent' })
    expect(selector).not.toBeDisabled()
    let released!: () => void
    agentSessionApi.stopByTaskId.mockImplementationOnce(() => new Promise(resolve => {
      released = () => resolve({ success: true, sessionId: 'session-1' })
    }))
    fireEvent.change(selector, { target: { value: 'other-agent' } })
    await waitFor(() => expect(agentSessionApi.stopByTaskId).toHaveBeenCalledWith(MASTERMIND))
    expect(selector).toBeDisabled()
    let sent!: Promise<void>
    act(() => { sent = (composer.send as (text: string) => Promise<void>)('continue our discussion') })
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.send).not.toHaveBeenCalled()
    agentSessionApi.start.mockResolvedValueOnce({ sessionId: 'session-2' })
    await act(async () => { released(); await sent })
    expect(selector).toHaveValue('other-agent')
    expect(selector).not.toBeDisabled()
    expect(screen.getByText('hello')).toBeVisible()
    expect(agentSessionApi.send).toHaveBeenCalledWith('session-2', 'continue our discussion', MASTERMIND, 'other-agent', undefined)
    expect(agentSessionApi.start).toHaveBeenCalledTimes(2)
    expect(settingsApi.set).toHaveBeenCalledWith(`mastermind_agent:${MASTERMIND}`, 'other-agent')
  })

  it('waits for a warm-up in flight before switching and retains the old choice on release failure', async () => {
    const started = deferredStart()
    render(<OrchestratorPanel onClose={vi.fn()} />)
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledOnce())
    const selector = screen.getByRole('combobox', { name: 'Mastermind agent' })
    agentSessionApi.stopByTaskId.mockRejectedValueOnce(new Error('Old agent is still running'))
    fireEvent.change(selector, { target: { value: 'other-agent' } })
    expect(agentSessionApi.stopByTaskId).not.toHaveBeenCalled()
    await act(async () => { started.resolve() })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Old agent is still running'))
    expect(selector).toHaveValue('default-agent')
    expect(selector).not.toBeDisabled()
    expect(agentSessionApi.start).toHaveBeenCalledOnce()
    expect(settingsApi.set).not.toHaveBeenCalled()
  })

  it('routes a message already waiting for warm-up to the newly selected agent', async () => {
    const started = deferredStart()
    render(<OrchestratorPanel onClose={vi.fn()} />)
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledOnce())
    let sent!: Promise<void>
    act(() => { sent = (composer.send as (text: string) => Promise<void>)('continue') })
    fireEvent.change(screen.getByRole('combobox', { name: 'Mastermind agent' }), { target: { value: 'other-agent' } })
    agentSessionApi.start.mockResolvedValueOnce({ sessionId: 'session-2' })
    await act(async () => { started.resolve(); await sent })
    expect(agentSessionApi.send).toHaveBeenCalledOnce()
    expect(agentSessionApi.send).toHaveBeenCalledWith('session-2', 'continue', MASTERMIND, 'other-agent', undefined)
  })

  it('does not start a replacement or repeat cleanup when a project is closed during a switch', async () => {
    const view = render(<OrchestratorPanel onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Choose project'))
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledWith('other-agent', 'mastermind-project-project-1', undefined, true))
    let release!: () => void
    agentSessionApi.stopByTaskId.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ success: true, sessionId: 'session-1' })
    }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Mastermind agent' }), { target: { value: 'default-agent' } })
    await waitFor(() => expect(agentSessionApi.stopByTaskId).toHaveBeenCalledOnce())
    const starts = agentSessionApi.start.mock.calls.length
    view.unmount()
    await act(async () => { release() })
    expect(agentSessionApi.start).toHaveBeenCalledTimes(starts)
    expect(agentSessionApi.stopByTaskId).toHaveBeenCalledOnce()
  })

  it('allows a project conversation agent change and restores its own saved choice on remount', async () => {
    settingsApi.get.mockImplementation(async key => key === 'mastermind_prewarm' ? 'false' : key === 'mastermind_agent:mastermind-project-project-1' ? 'default-agent' : null)
    const view = render(<OrchestratorPanel onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Choose project'))
    const selector = screen.getByRole('combobox', { name: 'Mastermind agent' })
    await waitFor(() => expect(selector).toHaveValue('default-agent'))
    fireEvent.change(selector, { target: { value: 'other-agent' } })
    await waitFor(() => expect(settingsApi.set).toHaveBeenCalledWith('mastermind_agent:mastermind-project-project-1', 'other-agent'))
    expect(agentSessionApi.stopByTaskId).toHaveBeenCalledWith('mastermind-project-project-1')
    expect(agentSessionApi.start).not.toHaveBeenCalled()
    expect(selector).toHaveValue('other-agent')
    view.unmount()
    settingsApi.get.mockImplementation(async key => key === 'mastermind_prewarm' ? 'false' : key === 'mastermind_agent:mastermind-project-project-1' ? 'other-agent' : null)
    render(<OrchestratorPanel onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Choose project'))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Mastermind agent' })).toHaveValue('other-agent'))
  })

  it('starts the session only once, however many times it re-renders', async () => {
    const view = render(<OrchestratorPanel onClose={vi.fn()} />)
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    await act(async () => {
      view.rerender(<OrchestratorPanel onClose={vi.fn()} />)
    })
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
  })

  /**
   * The reason warming needs care. Between the click and the session there is
   * a window in which there is no session yet and one is already being made.
   * The old code sent nothing in that window and said nothing about it.
   */
  it('holds a message sent while the session is still coming up', async () => {
    const started = deferredStart()
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))
    expect(composer.send).toBeTypeOf('function')

    // The user speaks before the agent has finished coming up.
    let sent: Promise<unknown> | undefined
    await act(async () => {
      sent = (composer.send as (t: string) => Promise<unknown>)('what is blocking the release')
    })
    expect(agentSessionApi.send).not.toHaveBeenCalled()

    await act(async () => {
      started.resolve()
      await sent
    })

    // One session, and the sentence survived the wait.
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.send).toHaveBeenCalledWith(
      'session-1',
      'what is blocking the release',
      MASTERMIND,
      'default-agent',
      undefined
    )
  })

  it('sends at once when the session is already warm', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))

    await act(async () => {
      await (composer.send as (t: string) => Promise<unknown>)('hello')
    })

    // No second start: the whole point of warming.
    expect(agentSessionApi.start).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.send).toHaveBeenCalledTimes(1)
  })
})
