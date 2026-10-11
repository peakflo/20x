import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HarnessInstanceView } from '@shared/harness-instances'

const list = vi.fn()
const create = vi.fn()
const update = vi.fn()
const remove = vi.fn()
const detectCandidates = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  harnessInstanceApi: {
    list: (...args: unknown[]) => list(...args),
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
    delete: (...args: unknown[]) => remove(...args),
    detectCandidates: (...args: unknown[]) => detectCandidates(...args)
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
  detectCandidates.mockReset().mockResolvedValue([])
})

afterEach(() => cleanup())

async function openAddAccountDialog(): Promise<HTMLElement> {
  render(<HarnessInstancesSection />)
  await screen.findByTestId('harness-instance-hi_work')
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
  return screen.findByRole('dialog')
}

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

  it('does not render the add-account form until the button is clicked', async () => {
    render(<HarnessInstancesSection />)
    await screen.findByTestId('harness-instance-hi_work')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Harness')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Home folder')).not.toBeInTheDocument()
  })

  it('opens the add-account modal from the header button, focused on Name', async () => {
    const dialog = await openAddAccountDialog()

    expect(within(dialog).getByRole('heading', { name: 'Add account' })).toBeInTheDocument()
    expect(
      within(dialog).getByText('Add another Claude Code or Codex subscription login. Agents pick it in their harness dropdown.')
    ).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getByLabelText('Name')).toHaveFocus())
  })

  it('suggests a home folder from the harness and name until edited by hand', async () => {
    const dialog = await openAddAccountDialog()

    const home = within(dialog).getByLabelText('Home folder') as HTMLInputElement
    expect(home.value).toBe('~/.codex')

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Side Project!' } })
    expect(home.value).toBe('~/.codex-side-project')

    fireEvent.change(within(dialog).getByLabelText('Harness'), { target: { value: 'claude-code' } })
    expect(home.value).toBe('~/.claude-side-project')

    fireEvent.change(home, { target: { value: '~/custom-path' } })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Side Project 2' } })
    expect(home.value).toBe('~/custom-path')
  })

  it('disables Add account while the name or home folder is empty', async () => {
    const dialog = await openAddAccountDialog()
    const submit = within(dialog).getByRole('button', { name: 'Add account' })

    expect(submit).toBeDisabled()

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Side project' } })
    expect(submit).not.toBeDisabled()

    fireEvent.change(within(dialog).getByLabelText('Home folder'), { target: { value: '' } })
    expect(submit).toBeDisabled()
  })

  it('creates an account, closes the modal, refreshes the list and highlights the new row', async () => {
    const created: HarnessInstanceView = {
      ...work,
      id: 'hi_new',
      label: 'Side project',
      home_path: '~/.codex-side-project'
    }
    list.mockReset()
    list.mockResolvedValueOnce([work, blocked])
    list.mockResolvedValueOnce([work, blocked, created])
    create.mockReset().mockResolvedValue(created)

    const dialog = await openAddAccountDialog()
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Side project' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add account' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        harness_type: 'codex',
        label: 'Side project',
        home_path: '~/.codex-side-project'
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))

    const row = await screen.findByTestId('harness-instance-hi_new')
    expect(row).toHaveAttribute('data-highlighted', 'true')
  })

  it('shows a server-side error inline and keeps the modal open', async () => {
    create.mockReset().mockRejectedValue(new Error('home_path already in use'))

    const dialog = await openAddAccountDialog()
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Side project' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add account' }))

    await waitFor(() => expect(within(dialog).getByText('home_path already in use')).toBeInTheDocument())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes without creating when Cancel is clicked', async () => {
    const dialog = await openAddAccountDialog()
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Side project' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(create).not.toHaveBeenCalled()
  })

  it('closes without creating on Escape', async () => {
    const dialog = await openAddAccountDialog()

    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(create).not.toHaveBeenCalled()
  })

  it('offers folders already signed in outside 20x, and fills the form when one is picked', async () => {
    detectCandidates.mockResolvedValue([{ home_path: '/Users/demo/.codex_work', suggested_label: 'Work' }])

    const dialog = await openAddAccountDialog()

    await waitFor(() => expect(detectCandidates).toHaveBeenCalledWith('codex'))
    const candidate = await within(dialog).findByRole('button', { name: /Work.*\.codex_work/ })
    fireEvent.click(candidate)

    expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Work')
    expect((within(dialog).getByLabelText('Home folder') as HTMLInputElement).value).toBe('/Users/demo/.codex_work')

    // Picking a candidate counts as a hand-edit: further name changes do not overwrite the chosen folder.
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Something else' } })
    expect((within(dialog).getByLabelText('Home folder') as HTMLInputElement).value).toBe('/Users/demo/.codex_work')
  })

  it('re-checks for detected folders when the harness changes', async () => {
    detectCandidates.mockResolvedValue([])
    const dialog = await openAddAccountDialog()
    await waitFor(() => expect(detectCandidates).toHaveBeenCalledWith('codex'))

    fireEvent.change(within(dialog).getByLabelText('Harness'), { target: { value: 'claude-code' } })

    await waitFor(() => expect(detectCandidates).toHaveBeenCalledWith('claude-code'))
  })

  it('shows nothing extra when no account is already signed in', async () => {
    const dialog = await openAddAccountDialog()
    await waitFor(() => expect(detectCandidates).toHaveBeenCalledWith('codex'))

    expect(within(dialog).queryByText('Detected on this machine')).not.toBeInTheDocument()
  })
})
