import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ReactNode } from 'react'

const agentSessionApi = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
  clearMastermind: vi.fn(async () => ({ success: true })),
  send: vi.fn(async () => ({ newSessionId: null })),
  respondToApproval: vi.fn(async () => undefined),
  resume: vi.fn(),
  getTranscriptSnapshot: vi.fn(async () => ({ parts: [], rev: 0 })),
}))
const settingsApi = vi.hoisted(() => ({
  get: vi.fn(async (_key?: string) => null as string | null),
  set: vi.fn(async () => undefined),
}))
const agentApi = vi.hoisted(() => ({
  getAll: vi.fn(async () => [
    { id: 'default-agent', name: 'Claude', is_default: true },
    { id: 'other-agent', name: 'Codex', is_default: false },
  ]),
}))
const memoryApi = vi.hoisted(() => ({
  update: vi.fn(async () => undefined),
  delete: vi.fn(async () => true),
}))
/** Captured so a test can fire the "memory loaded"/"memory saved" events like the main process would. */
const memoryListeners = vi.hoisted(() => ({
  context: null as ((event: { count: number; ids: string[] }) => void) | null,
  saved: null as ((event: { memory: { id: string; content: string }; deduped: boolean; updated: boolean; previous?: unknown }) => void) | null,
}))
const onMastermindMemoryContext = vi.hoisted(() => vi.fn((cb: typeof memoryListeners.context) => {
  memoryListeners.context = cb
  return vi.fn()
}))
const onMastermindMemorySaved = vi.hoisted(() => vi.fn((cb: typeof memoryListeners.saved) => {
  memoryListeners.saved = cb
  return vi.fn()
}))

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  agentApi,
  settingsApi,
  agentSessionApi,
  memoryApi,
  onMastermindMemoryContext,
  onMastermindMemorySaved,
}))

/**
 * The transcript is a large tree with its own IPC; this file is about the
 * session. Its send handler is captured so a test can send like a user.
 */
const composer = vi.hoisted(() => ({ send: null as ((text: string) => void) | null }))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({
  AgentTranscriptPanel: ({ onSend, headerLeading, headerTrailing }: { onSend?: (text: string) => void; headerLeading?: ReactNode; headerTrailing?: ReactNode }) => {
    composer.send = onSend ?? null
    return <div>{headerLeading}{headerTrailing}</div>
  },
}))

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
  composer.send = null
  memoryListeners.context = null
  memoryListeners.saved = null
})

describe('OrchestratorPanel — warming the session', () => {
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

  it('shows the agent as a plain name, not a picker', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())

    // The header used to carry a <select>, which invited switching agents
    // mid-conversation; now it is a read-only name + icon badge.
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
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

describe('OrchestratorPanel — "Remembering N things" indicator', () => {
  it('shows nothing until the main process reports memories were loaded', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())

    expect(screen.queryByText(/Remembering/)).not.toBeInTheDocument()
  })

  it('shows the count once the main process reports the injected memories', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(memoryListeners.context).toBeTypeOf('function'))

    act(() => {
      memoryListeners.context!({ count: 12, ids: ['m1', 'm2'] })
    })

    expect(screen.getByText('Remembering 12 things')).toBeInTheDocument()
  })

  it('uses the singular for exactly one memory', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(memoryListeners.context).toBeTypeOf('function'))

    act(() => {
      memoryListeners.context!({ count: 1, ids: ['m1'] })
    })

    expect(screen.getByText('Remembering 1 thing')).toBeInTheDocument()
  })

  it('shows nothing when the session injected an empty block (no memories yet)', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(memoryListeners.context).toBeTypeOf('function'))

    act(() => {
      memoryListeners.context!({ count: 0, ids: [] })
    })

    expect(screen.queryByText(/Remembering/)).not.toBeInTheDocument()
  })
})

describe('OrchestratorPanel — "saved a memory" toast with Undo', () => {
  it('shows a toast when Mastermind saves a new memory, and Undo deletes it', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(memoryListeners.saved).toBeTypeOf('function'))

    act(() => {
      memoryListeners.saved!({
        memory: { id: 'mem-1', content: 'Always use pnpm.' },
        deduped: false,
        updated: false
      })
    })

    expect(screen.getByText(/Mastermind saved a memory:/)).toBeInTheDocument()
    expect(screen.getByText('Always use pnpm.')).toBeInTheDocument()

    await act(async () => {
      screen.getByRole('button', { name: 'Undo' }).click()
    })

    expect(memoryApi.delete).toHaveBeenCalledWith('mem-1')
    expect(memoryApi.update).not.toHaveBeenCalled()
    expect(screen.queryByText(/Mastermind saved a memory:/)).not.toBeInTheDocument()
  })

  it('describes a dedupe-merge differently, and Undo restores the previous content instead of deleting', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(memoryListeners.saved).toBeTypeOf('function'))

    act(() => {
      memoryListeners.saved!({
        memory: { id: 'mem-1', content: 'Use pnpm always, never npm or yarn.' },
        deduped: true,
        updated: false,
        previous: { content: 'Always use pnpm.', kind: 'preference', scope: 'global', importance: 3, pinned: false }
      })
    })

    expect(screen.getByText(/Mastermind merged a near-identical memory:/)).toBeInTheDocument()

    await act(async () => {
      screen.getByRole('button', { name: 'Undo' }).click()
    })

    expect(memoryApi.update).toHaveBeenCalledWith('mem-1', {
      content: 'Always use pnpm.',
      kind: 'preference',
      scope: 'global',
      importance: 3,
      pinned: false
    })
    expect(memoryApi.delete).not.toHaveBeenCalled()
  })

  it('dismisses the toast without calling Undo', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(memoryListeners.saved).toBeTypeOf('function'))

    act(() => {
      memoryListeners.saved!({ memory: { id: 'mem-1', content: 'A note' }, deduped: false, updated: false })
    })
    expect(screen.getByText(/Mastermind saved a memory:/)).toBeInTheDocument()

    await act(async () => {
      screen.getByRole('button', { name: 'Dismiss' }).click()
    })

    expect(screen.queryByText(/Mastermind saved a memory:/)).not.toBeInTheDocument()
    expect(memoryApi.delete).not.toHaveBeenCalled()
    expect(memoryApi.update).not.toHaveBeenCalled()
  })
})

describe('OrchestratorPanel — "Clear conversation" with the optional "Save what I learned" offer', () => {
  it('clears immediately when the setting is off (the default)', async () => {
    settingsApi.get.mockResolvedValue(null) // off by default
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())

    await act(async () => {
      screen.getByLabelText('Clear conversation').click()
    })

    expect(agentSessionApi.send).not.toHaveBeenCalled()
    expect(agentSessionApi.clearMastermind).toHaveBeenCalled()
  })

  it('asks Mastermind to propose memories first when the setting is on, and only clears on a second click', async () => {
    settingsApi.get.mockImplementation(async (key?: string) =>
      key === 'mastermind-save-what-i-learned' ? 'true' : null
    )
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalled())

    await act(async () => {
      screen.getByLabelText('Clear conversation').click()
    })

    // First click: proposes memories, does not clear yet.
    expect(agentSessionApi.send).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('propose any durable preferences'),
      MASTERMIND,
      'default-agent',
      undefined
    )
    expect(agentSessionApi.clearMastermind).not.toHaveBeenCalled()
    expect(await screen.findByLabelText('Clear conversation now')).toBeInTheDocument()

    await act(async () => {
      screen.getByLabelText('Clear conversation now').click()
    })

    // Second click: actually clears, without asking again.
    expect(agentSessionApi.send).toHaveBeenCalledTimes(1)
    expect(agentSessionApi.clearMastermind).toHaveBeenCalled()
  })
})
