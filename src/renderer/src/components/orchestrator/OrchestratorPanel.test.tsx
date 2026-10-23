import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ReactNode } from 'react'

const agentSessionApi = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
  send: vi.fn(async () => ({ newSessionId: null })),
  respondToApproval: vi.fn(async () => undefined),
  resume: vi.fn(),
  getTranscriptSnapshot: vi.fn(async () => ({ parts: [], rev: 0 })),
}))
const settingsApi = vi.hoisted(() => ({
  get: vi.fn(async () => null as string | null),
  set: vi.fn(async () => undefined),
}))
const agentApi = vi.hoisted(() => ({
  getAll: vi.fn(async () => [
    { id: 'default-agent', name: 'Claude', is_default: true },
    { id: 'other-agent', name: 'Codex', is_default: false },
  ]),
}))

const attachmentApi = vi.hoisted(() => ({
  pick: vi.fn(async () => [] as string[]),
  save: vi.fn(async (_taskId: string, filePath: string) => ({
    id: `att-${filePath.split('/').pop()}`,
    filename: filePath.split('/').pop() as string,
    size: 2048,
    mime_type: 'image/png',
    added_at: '2026-10-22T00:00:00.000Z',
  })),
}))

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  agentApi,
  settingsApi,
  agentSessionApi,
  attachmentApi,
}))

/**
 * The transcript is a large tree with its own IPC; this file is about the
 * session. Its send handler is captured so a test can send like a user.
 */
type Attachment = { id: string; filename: string; size: number; mime_type: string }
type SendFn = (text: string, options?: { attachments?: Attachment[] }) => unknown
const composer = vi.hoisted(() => ({
  send: null as SendFn | null,
  addPaths: null as ((paths: string[]) => Promise<Attachment[]>) | null,
  pick: null as (() => Promise<Attachment[]>) | null,
}))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({
  AgentTranscriptPanel: ({ onSend, onAddAttachmentPaths, onPickAttachments, headerLeading, headerTrailing }: {
    onSend?: SendFn
    onAddAttachmentPaths?: (paths: string[]) => Promise<Attachment[]>
    onPickAttachments?: () => Promise<Attachment[]>
    headerLeading?: ReactNode
    headerTrailing?: ReactNode
  }) => {
    composer.send = onSend ?? null
    composer.addPaths = onAddAttachmentPaths ?? null
    composer.pick = onPickAttachments ?? null
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
  composer.addPaths = null
  composer.pick = null
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

/**
 * Clipboard paste, drag-and-drop and the file picker all reach the composer
 * through `onAddAttachmentPaths` / `onPickAttachments`. Mastermind used to pass
 * neither, so a pasted screenshot did nothing there.
 */
describe('OrchestratorPanel — attachments', () => {
  it('gives the composer an attachment handler, so paste and drop are enabled', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    expect(composer.addPaths).toBeTypeOf('function')
    expect(composer.pick).toBeTypeOf('function')
  })

  it('stores a pasted file under the Mastermind session and sends it with the message', async () => {
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    await waitFor(() => expect(agentSessionApi.start).toHaveBeenCalledTimes(1))

    let added: Attachment[] = []
    await act(async () => {
      added = await (composer.addPaths as (paths: string[]) => Promise<Attachment[]>)(['/tmp/staged/pasted-image.png'])
    })
    expect(attachmentApi.save).toHaveBeenCalledWith(MASTERMIND, '/tmp/staged/pasted-image.png')
    expect(added).toEqual([expect.objectContaining({ filename: 'pasted-image.png' })])

    await act(async () => {
      await (composer.send as SendFn)('what is in this screenshot', { attachments: added })
    })
    expect(agentSessionApi.send).toHaveBeenCalledWith(
      'session-1',
      'what is in this screenshot',
      MASTERMIND,
      'default-agent',
      added
    )
  })

  it('saves files chosen in the picker under the Mastermind session', async () => {
    attachmentApi.pick.mockResolvedValue(['/Users/me/spec.pdf'])
    await act(async () => {
      render(<OrchestratorPanel onClose={vi.fn()} />)
    })
    let picked: Attachment[] = []
    await act(async () => {
      picked = await (composer.pick as () => Promise<Attachment[]>)()
    })
    expect(attachmentApi.save).toHaveBeenCalledWith(MASTERMIND, '/Users/me/spec.pdf')
    expect(picked).toHaveLength(1)
  })
})
