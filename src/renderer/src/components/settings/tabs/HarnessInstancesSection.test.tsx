import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HarnessInstanceView } from '@shared/harness-instances'

const list = vi.fn()
const create = vi.fn()
const update = vi.fn()
const remove = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  harnessInstanceApi: {
    list: (...args: unknown[]) => list(...args),
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
    delete: (...args: unknown[]) => remove(...args)
  }
}))

import { HarnessInstancesSection } from './HarnessInstancesSection'
import { useHarnessInstanceStore } from '@/stores/harness-instance-store'

const work: HarnessInstanceView = {
  id: 'hi_work',
  harness_type: 'codex',
  label: 'Work',
  home_path: '/accounts/codex-work',
  created_at: '2026-10-05T00:00:00.000Z',
  shares_history: true
}
const blocked: HarnessInstanceView = {
  id: 'hi_blocked',
  harness_type: 'claude-code',
  label: 'Personal',
  home_path: '/accounts/claude-personal',
  created_at: '2026-10-05T00:00:00.000Z',
  shares_history: false
}

beforeEach(() => {
  cleanup()
  useHarnessInstanceStore.setState({ instances: [], loaded: false })
  list.mockReset().mockResolvedValue([work, blocked])
  create.mockReset().mockResolvedValue({ ...work, id: 'hi_new' })
  update.mockReset().mockResolvedValue({ ...work, label: 'Team' })
  remove.mockReset().mockResolvedValue(true)
})

describe('HarnessInstancesSection', () => {
  it('lists each account with its sign-in commands for POSIX and PowerShell', async () => {
    render(<HarnessInstancesSection />)

    const row = await screen.findByTestId('harness-instance-hi_work')
    expect(within(row).getByText('Codex · Work')).toBeTruthy()
    expect(within(row).getByText('CODEX_HOME="/accounts/codex-work" codex login')).toBeTruthy()
    expect(within(row).getByText('$env:CODEX_HOME = "/accounts/codex-work"; codex login')).toBeTruthy()
  })

  it('says whether an account shares its session history', async () => {
    render(<HarnessInstancesSection />)

    const shared = await screen.findByTestId('harness-instance-hi_work')
    expect(within(shared).getByTestId('harness-instance-sharing').textContent).toBe('Tasks continue natively')
    const separate = screen.getByTestId('harness-instance-hi_blocked')
    expect(within(separate).getByTestId('harness-instance-sharing').textContent).toBe('Context is carried over')
    expect(within(separate).getByText('CLAUDE_CONFIG_DIR="/accounts/claude-personal" claude /login')).toBeTruthy()
  })

  it('adds an account and reloads the list', async () => {
    render(<HarnessInstancesSection />)
    await screen.findByTestId('harness-instance-hi_work')

    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'codex' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Side project' } })
    fireEvent.change(screen.getByLabelText('Home folder'), { target: { value: '~/.codex-side' } })
    fireEvent.click(screen.getByRole('button', { name: /add account/i }))

    await waitFor(() => expect(create).toHaveBeenCalledWith({ harness_type: 'codex', label: 'Side project', home_path: '~/.codex-side' }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('renames an account', async () => {
    render(<HarnessInstancesSection />)
    await screen.findByTestId('harness-instance-hi_work')

    fireEvent.click(screen.getByRole('button', { name: 'Rename Codex · Work' }))
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('hi_work', { label: 'Team' }))
  })

  it('removes an account', async () => {
    render(<HarnessInstancesSection />)
    await screen.findByTestId('harness-instance-hi_work')

    fireEvent.click(screen.getByRole('button', { name: 'Remove Codex · Work' }))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('hi_work'))
  })
})
