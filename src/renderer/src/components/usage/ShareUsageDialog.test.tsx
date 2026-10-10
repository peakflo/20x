import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UsageCardSummary } from '@shared/usage-card'

const copyImageToClipboard = vi.fn()
const saveImage = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  usageApi: {
    copyImageToClipboard: (...args: unknown[]) => copyImageToClipboard(...args),
    saveImage: (...args: unknown[]) => saveImage(...args)
  }
}))

import { ShareUsageDialog } from './ShareUsageDialog'

const summary: UsageCardSummary = {
  periodLabel: 'Last 30 days',
  multiplier: 3.4,
  hours: 120,
  wall: 35,
  peakDay: { atMs: Date.UTC(2026, 0, 15), peak: 5 },
  tasksShipped: 12,
  tokens: 45_000_000,
  calendar: [{ day: '2026-01-15', hours: 4 }]
}

beforeEach(() => {
  cleanup()
  copyImageToClipboard.mockReset().mockResolvedValue({ success: true })
  saveImage.mockReset().mockResolvedValue({ saved: true })
  // jsdom/happy-dom's canvas has no real 2D context — toDataURL/toBlob are
  // stubbed here so the dialog can render a "preview" deterministically.
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,stub')
  HTMLCanvasElement.prototype.toBlob = vi.fn(function (this: HTMLCanvasElement, cb: BlobCallback) {
    cb(new Blob(['stub'], { type: 'image/png' }))
  })
})

describe('ShareUsageDialog', () => {
  it('renders a preview once open, with the shape/colour options and name field', async () => {
    const onNameChange = vi.fn()
    render(
      <ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={onNameChange} onOpenChange={() => {}} />
    )
    expect(await screen.findByAltText('Preview of the share image')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Wide' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Azure' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByDisplayValue('Dmitry')).toBeInTheDocument()
  })

  it('re-renders the preview when the shape changes', async () => {
    render(<ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={() => {}} onOpenChange={() => {}} />)
    await screen.findByAltText('Preview of the share image')
    const callsBefore = (HTMLCanvasElement.prototype.toDataURL as ReturnType<typeof vi.fn>).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Tall' }))
    await waitFor(() => expect((HTMLCanvasElement.prototype.toDataURL as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore))
    expect(screen.getByRole('button', { name: 'Tall' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Wide' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('re-renders the preview when the colour changes', async () => {
    render(<ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={() => {}} onOpenChange={() => {}} />)
    await screen.findByAltText('Preview of the share image')
    fireEvent.click(screen.getByRole('button', { name: 'Ink' }))
    expect(screen.getByRole('button', { name: 'Ink' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onNameChange and reflects the typed name in the input', async () => {
    const onNameChange = vi.fn()
    render(<ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={onNameChange} onOpenChange={() => {}} />)
    const input = await screen.findByLabelText('Name on the card')
    fireEvent.change(input, { target: { value: 'Alex' } })
    expect(onNameChange).toHaveBeenCalledWith('Alex')
  })

  it('copies the image via the Web Clipboard API when available', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
    render(<ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={() => {}} onOpenChange={() => {}} />)
    await screen.findByAltText('Preview of the share image')
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(await screen.findByText('Image copied. Paste it anywhere.')).toBeInTheDocument()
    expect(copyImageToClipboard).not.toHaveBeenCalled()
  })

  it('falls back to the IPC clipboard path when the Web Clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    render(<ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={() => {}} onOpenChange={() => {}} />)
    await screen.findByAltText('Preview of the share image')
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    await waitFor(() => expect(copyImageToClipboard).toHaveBeenCalled())
    expect(await screen.findByText('Image copied. Paste it anywhere.')).toBeInTheDocument()
  })

  it('shows a failure status when the IPC clipboard fallback reports failure', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    copyImageToClipboard.mockResolvedValue({ success: false })
    render(<ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={() => {}} onOpenChange={() => {}} />)
    await screen.findByAltText('Preview of the share image')
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    expect(await screen.findByText('Could not copy the image.')).toBeInTheDocument()
  })

  it('saves the PNG via IPC with the expected default file name', async () => {
    render(<ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={() => {}} onOpenChange={() => {}} />)
    await screen.findByAltText('Preview of the share image')
    fireEvent.click(screen.getByRole('button', { name: 'Save PNG' }))
    await waitFor(() => expect(saveImage).toHaveBeenCalled())
    expect(saveImage.mock.calls[0][1]).toBe('20x-usage-30d-wide.png')
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
  })

  it('shows a canceled status when the save dialog is dismissed', async () => {
    saveImage.mockResolvedValue({ saved: false })
    render(<ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={() => {}} onOpenChange={() => {}} />)
    await screen.findByAltText('Preview of the share image')
    fireEvent.click(screen.getByRole('button', { name: 'Save PNG' }))
    expect(await screen.findByText('Save canceled.')).toBeInTheDocument()
  })

  it('shows the "made on your computer, nothing uploaded" hint text (verbatim from the mock)', async () => {
    render(<ShareUsageDialog open summary={summary} periodDaysLabel="30d" name="Dmitry" onNameChange={() => {}} onOpenChange={() => {}} />)
    expect(await screen.findByText(/made on your computer. Nothing is uploaded/)).toBeInTheDocument()
  })
})
