import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { UpdateDialog } from './UpdateDialog'

// Access the mock electronAPI from setup-renderer.ts — cast to Mock for vi helpers
const mockUpdater = window.electronAPI.updater as unknown as {
  check: Mock
  download: Mock
  install: Mock
  getVersion: Mock
  onStatus: Mock
  onMenuCheckForUpdates: Mock
}

describe('UpdateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdater.check.mockResolvedValue({ success: true })
    mockUpdater.getVersion.mockResolvedValue('0.0.31')
  })

  it('should show checking state when opened', () => {
    render(<UpdateDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByText('Checking for updates...')).toBeInTheDocument()
  })

  it('should call updater.check when opened', () => {
    render(<UpdateDialog open={true} onClose={vi.fn()} />)
    expect(mockUpdater.check).toHaveBeenCalled()
  })

  it('should display current version', async () => {
    render(<UpdateDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      // Radix Dialog may render duplicate nodes; just check at least one exists
      expect(screen.getAllByText('v0.0.31').length).toBeGreaterThan(0)
    })
  })

  it('should show error when check fails (e.g. dev mode)', async () => {
    mockUpdater.check.mockResolvedValue({ success: false, error: 'Updater not available in dev mode' })

    render(<UpdateDialog open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Updater not available in dev mode')).toBeInTheDocument()
    })
  })

  it('should show up-to-date state via onStatus event', async () => {
    let statusCallback: ((data: Record<string, unknown>) => void) | null = null
    mockUpdater.onStatus.mockImplementation((cb: (data: Record<string, unknown>) => void) => {
      statusCallback = cb
      return vi.fn()
    })

    render(<UpdateDialog open={true} onClose={vi.fn()} />)

    // Simulate the main process sending 'up-to-date'
    statusCallback!({ status: 'up-to-date', currentVersion: '0.0.31' })

    await waitFor(() => {
      // Radix Dialog may render duplicate nodes
      expect(screen.getAllByText(/up to date/i).length).toBeGreaterThan(0)
    })
  })

  it('should show update available state with version and download button', async () => {
    let statusCallback: ((data: Record<string, unknown>) => void) | null = null
    mockUpdater.onStatus.mockImplementation((cb: (data: Record<string, unknown>) => void) => {
      statusCallback = cb
      return vi.fn()
    })

    render(<UpdateDialog open={true} onClose={vi.fn()} />)

    statusCallback!({
      status: 'available',
      version: '1.0.0',
      releaseNotes: '## Bug fixes\n- Fixed crash',
      releaseDate: '2026-04-17',
      currentVersion: '0.0.31'
    })

    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument()
      expect(screen.getByText('Download Update')).toBeInTheDocument()
    })
  })

  it('should show Install & Restart button when downloaded', async () => {
    let statusCallback: ((data: Record<string, unknown>) => void) | null = null
    mockUpdater.onStatus.mockImplementation((cb: (data: Record<string, unknown>) => void) => {
      statusCallback = cb
      return vi.fn()
    })

    render(<UpdateDialog open={true} onClose={vi.fn()} />)

    statusCallback!({ status: 'downloaded', version: '1.0.0' })

    await waitFor(() => {
      expect(screen.getByText('Install & Restart')).toBeInTheDocument()
    })
  })

  it('should call onClose when Close button is clicked', () => {
    const onClose = vi.fn()
    render(<UpdateDialog open={true} onClose={onClose} />)

    // The Close button is a <button> with variant="outline"
    const closeButtons = screen.getAllByRole('button', { name: /close/i })
    fireEvent.click(closeButtons[closeButtons.length - 1])
    expect(onClose).toHaveBeenCalled()
  })

  it('should show Check for Updates button when up-to-date', async () => {
    let statusCallback: ((data: Record<string, unknown>) => void) | null = null
    mockUpdater.onStatus.mockImplementation((cb: (data: Record<string, unknown>) => void) => {
      statusCallback = cb
      return vi.fn()
    })

    render(<UpdateDialog open={true} onClose={vi.fn()} />)

    // Simulate main process sending 'up-to-date'
    statusCallback!({ status: 'up-to-date', currentVersion: '0.0.31' })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /check for updates/i })).toBeInTheDocument()
    })
  })

  it('should re-trigger check when Check for Updates button is clicked from up-to-date state', async () => {
    let statusCallback: ((data: Record<string, unknown>) => void) | null = null
    mockUpdater.onStatus.mockImplementation((cb: (data: Record<string, unknown>) => void) => {
      statusCallback = cb
      return vi.fn()
    })

    render(<UpdateDialog open={true} onClose={vi.fn()} />)

    // Simulate reaching up-to-date state
    statusCallback!({ status: 'up-to-date', currentVersion: '0.0.31' })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /check for updates/i })).toBeInTheDocument()
    })

    // Click the Check for Updates button
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }))

    // Should transition to checking state and call updater.check again
    // Radix Dialog may render duplicate nodes, so we check at least one exists
    await waitFor(() => {
      expect(screen.getAllByText('Checking for updates...').length).toBeGreaterThan(0)
    })
    // check is called once on open (idle→checking) and once on button click
    expect(mockUpdater.check).toHaveBeenCalledTimes(2)
  })
})
