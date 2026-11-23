import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConnectProgress, PreflightResult } from '@shared/enterprise-runners'

const preflight = vi.fn()
const connectStart = vi.fn()
const connectCancel = vi.fn()
const connectProgress = vi.fn()
const openApproval = vi.fn()
let progressListener: ((p: ConnectProgress) => void) | null = null

vi.mock('@/lib/ipc-client', () => ({
  enterpriseRunnersApi: {
    preflight: (...a: unknown[]) => preflight(...a),
    connectStart: (...a: unknown[]) => connectStart(...a),
    connectCancel: (...a: unknown[]) => connectCancel(...a),
    connectProgress: (...a: unknown[]) => connectProgress(...a),
    openApproval: (...a: unknown[]) => openApproval(...a),
    onConnectProgress: (cb: (p: ConnectProgress) => void) => {
      progressListener = cb
      return () => { progressListener = null }
    },
    list: vi.fn(async () => ({ ok: false, error: { kind: 'unavailable', message: 'n/a' } }))
  }
}))

import { ConnectComputerModal } from './ConnectComputerModal'
import { useConnectComputerStore } from '@/stores/connect-computer-store'

const OK: PreflightResult = {
  ok: true,
  checks: [
    { id: 'os', ok: true, detail: 'macOS arm64' },
    { id: 'signed_in', ok: true, detail: 'Signed in to Peakflo Enterprise' },
    { id: 'node', ok: true, detail: 'Node 22.23.5' },
    { id: 'git', ok: true, detail: 'Git 2.45.1' }
  ],
  versionError: null,
  pinnedVersion: '1.8.2',
  nodeEngines: '^22.23.5',
  controlPlane: 'https://api.peakflo.ai',
  failure: null
}

const progress = (patch: Partial<ConnectProgress> = {}): ConnectProgress => ({
  runId: 'run-1',
  phase: 'running',
  steps: { connection: 'done', approve: 'active', register: 'pending', service: 'pending' },
  lines: ['Waiting for approval…'],
  approveUrl: 'https://app.peakflo.ai/connect-computer?connection=3f6c2a9e-8b1d-4c7a-9e2f-5d4b1a0c7e63&vendor=computer',
  machineName: 'studio-mac',
  company: null,
  harnessesConnected: [],
  failure: null,
  commandDisplay: 'npx --yes @peakflo/agent-harness@1.8.2 connect --connection 3f6c2a9e-8b1d-4c7a-9e2f-5d4b1a0c7e63 --control-plane https://api.peakflo.ai',
  ...patch
})

beforeEach(() => {
  preflight.mockResolvedValue(OK)
  connectProgress.mockResolvedValue(null)
  connectStart.mockResolvedValue({ ok: true, runId: 'run-1' })
  useConnectComputerStore.getState().openConnect()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useConnectComputerStore.getState().close()
})

async function openModal() {
  render(<ConnectComputerModal />)
  await screen.findByText('Node 22.23.5')
}

describe('ConnectComputerModal — before connecting', () => {
  it('shows the pre-install check and the command, with a placeholder id and no token', async () => {
    await openModal()
    for (const text of ['macOS arm64', 'Node 22.23.5', 'Git 2.45.1', 'Signed in to Peakflo Enterprise']) expect(screen.getByText(text)).toBeTruthy()
    const preview = screen.getByTestId('command-preview').textContent ?? ''
    expect(preview).toBe('$ npx --yes @peakflo/agent-harness@1.8.2 connect --connection <connection-id> --control-plane https://api.peakflo.ai')
    expect(preview).not.toMatch(/--token|--all/)
  })

  it('disables --ask when a single harness is picked, and drops it from the command', async () => {
    await openModal()
    const ask = screen.getByRole('checkbox') as HTMLInputElement
    expect(ask.disabled).toBe(false)
    fireEvent.click(ask)
    expect(screen.getByTestId('command-preview').textContent).toContain('connect --ask --connection')
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('command-preview').textContent).toContain('connect codex --connection')
    expect(screen.getByTestId('command-preview').textContent).not.toContain('--ask')
  })

  it('starts with the picked harness', async () => {
    await openModal()
    fireEvent.click(screen.getByRole('radio', { name: 'Cursor' }))
    fireEvent.click(screen.getByRole('button', { name: /connect$/i }))
    await waitFor(() => expect(connectStart).toHaveBeenCalledWith({ vendor: 'cursor', ask: false }))
  })

  it('Windows: shows "not supported" and no Connect button', async () => {
    preflight.mockResolvedValue({
      ...OK,
      ok: false,
      checks: [{ id: 'os', ok: false, detail: 'Windows x64', help: 'Runners need macOS or Linux.' }],
      failure: { kind: 'unsupported_os', message: 'Runners need macOS or Linux. Use a Mac/Linux machine or a shared runner.' }
    })
    render(<ConnectComputerModal />)
    expect(await screen.findByText("Windows isn't supported")).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
  })

  it('Node missing: shows install help and a Re-check that re-runs the check', async () => {
    preflight.mockResolvedValueOnce({
      ...OK,
      ok: false,
      checks: [{ id: 'node', ok: false, detail: 'Node — none found', help: 'brew install node' }],
      failure: { kind: 'node_missing', message: 'Node.js was not found.', help: 'brew install node' }
    })
    render(<ConnectComputerModal />)
    expect(await screen.findByText('Missing requirements')).toBeTruthy()
    expect(screen.getAllByText('brew install node').length).toBeGreaterThan(0)
    expect((screen.getByRole('button', { name: /^connect$/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    await waitFor(() => expect(preflight).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Node 22.23.5')).toBeTruthy()
  })

  it('Git missing', async () => {
    preflight.mockResolvedValueOnce({
      ...OK,
      ok: false,
      checks: [{ id: 'git', ok: false, detail: 'Git — none found', help: 'xcode-select --install' }],
      failure: { kind: 'git_missing', message: 'Git was not found.', help: 'xcode-select --install' }
    })
    render(<ConnectComputerModal />)
    expect(await screen.findByText('Git was not found.')).toBeTruthy()
  })

  it('start failure (rate limited) is shown and retryable', async () => {
    connectStart.mockResolvedValueOnce({ ok: false, failure: { kind: 'rate_limited', message: 'Too many connection attempts. Try again later.' } })
    await openModal()
    fireEvent.click(screen.getByRole('button', { name: /connect$/i }))
    expect(await screen.findByText('Too many attempts')).toBeTruthy()
  })
})

describe('ConnectComputerModal — running', () => {
  async function startRun() {
    await openModal()
    fireEvent.click(screen.getByRole('button', { name: /connect$/i }))
    await waitFor(() => expect(connectStart).toHaveBeenCalled())
  }
  const push = (p: ConnectProgress) => act(() => { progressListener?.(p) })

  it('shows the four steps and the approval card, and can reopen the page', async () => {
    await startRun()
    push(progress())
    const steps = screen.getByRole('list', { name: 'Connection progress' })
    expect(Array.from(steps.querySelectorAll('li')).map((li) => li.getAttribute('data-state'))).toEqual(['done', 'active', 'pending', 'pending'])
    expect(screen.getByTestId('approve-card')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /open the page again/i }))
    expect(openApproval).toHaveBeenCalledWith('run-1')
  })

  it('success: shows the machine and links to Machines', async () => {
    await startRun()
    push(progress({
      phase: 'success',
      steps: { connection: 'done', approve: 'done', register: 'done', service: 'done' },
      harnessesConnected: ['Claude Code', 'Codex'],
      company: 'Northwind Demo Co'
    }))
    expect(screen.getByTestId('connect-success').textContent).toMatch(/studio-mac is connected/)
    expect(screen.getByTestId('connect-success').textContent).toMatch(/Claude Code, Codex/)
    expect(screen.getByRole('button', { name: 'View in Machines' })).toBeTruthy()
  })

  const failures = [
    ['denied', { kind: 'denied', message: 'Approval was cancelled. Nothing was installed on this computer.' }, 'Not connected', 'Try again'],
    ['expired', { kind: 'expired', message: 'This connection has expired or was already used.' }, 'Cannot connect', 'Get a new connection'],
    ['service_failed', { kind: 'service_failed', message: 'launchctl bootstrap failed', logPath: '~/.pf-agent-harness/logs' }, "Registered, but the service didn't start", 'Retry service install']
  ] as const
  for (const [kind, failure, title, action] of failures) {
    it(`failure: ${kind}`, async () => {
      await startRun()
      push(progress({ phase: 'failed', failure, steps: { connection: 'done', approve: kind === 'service_failed' ? 'done' : 'failed', register: 'done', service: kind === 'service_failed' ? 'failed' : 'pending' } }))
      expect(screen.getByText(title)).toBeTruthy()
      expect(screen.getByRole('button', { name: action })).toBeTruthy()
      if (kind === 'service_failed') expect(screen.getByText('~/.pf-agent-harness/logs')).toBeTruthy()
    })
  }

  it('retry goes back to the check', async () => {
    await startRun()
    push(progress({ phase: 'failed', failure: { kind: 'denied', message: 'x' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(preflight).toHaveBeenCalledTimes(2))
  })

  it('only shows redacted output', async () => {
    await startRun()
    push(progress({ lines: ['Authorization: Bearer [redacted]'] }))
    fireEvent.click(screen.getByText('Show output'))
    expect(screen.getByTestId('connect-log').textContent).toContain('[redacted]')
  })

  it('Cancel stops the run', async () => {
    await startRun()
    push(progress())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(connectCancel).toHaveBeenCalledWith('run-1')
  })
})

describe('ConnectComputerModal — Reconnect', () => {
  it('passes the machine being replaced', async () => {
    useConnectComputerStore.getState().openConnect({ replacesRunnerId: '3f6c2a9e-8b1d-4c7a-9e2f-5d4b1a0c7e63', replacesName: 'old-laptop' })
    await openModal()
    expect(screen.getByText('Reconnect old-laptop')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /connect$/i }))
    await waitFor(() =>
      expect(connectStart).toHaveBeenCalledWith({ vendor: 'all', ask: false, replacesRunnerId: '3f6c2a9e-8b1d-4c7a-9e2f-5d4b1a0c7e63' })
    )
  })
})
