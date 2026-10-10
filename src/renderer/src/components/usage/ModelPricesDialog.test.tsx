import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CustomModelPrice } from '@shared/usage'

const listModelPrices = vi.fn()
const setModelPrice = vi.fn()
const resetModelPrice = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  usageApi: {
    listModelPrices: (...args: unknown[]) => listModelPrices(...args),
    setModelPrice: (...args: unknown[]) => setModelPrice(...args),
    resetModelPrice: (...args: unknown[]) => resetModelPrice(...args)
  }
}))

import { ModelPricesDialog } from './ModelPricesDialog'

const existing: CustomModelPrice = { model: 'my-model', inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.5 }

beforeEach(() => {
  cleanup()
  listModelPrices.mockReset().mockResolvedValue([existing])
  setModelPrice.mockReset().mockResolvedValue([existing])
  resetModelPrice.mockReset().mockResolvedValue([])
})

describe('ModelPricesDialog', () => {
  it('loads and lists existing custom prices when opened', async () => {
    render(<ModelPricesDialog open onOpenChange={() => undefined} />)
    expect(await screen.findByText('my-model')).toBeInTheDocument()
    expect(screen.getByText('$1')).toBeInTheDocument()
  })

  it('prefills the model id when opened from a "Set price" row action', async () => {
    render(<ModelPricesDialog open onOpenChange={() => undefined} initialModel="some-other-model" />)
    expect(await screen.findByLabelText('Model id')).toHaveValue('some-other-model')
  })

  it('saves a new price with the entered rates', async () => {
    render(<ModelPricesDialog open onOpenChange={() => undefined} />)
    await screen.findByText('my-model')

    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'new-model' } })
    fireEvent.change(screen.getByLabelText('Input $/M tok'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Output $/M tok'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: /save price/i }))

    await waitFor(() => expect(setModelPrice).toHaveBeenCalledWith({
      model: 'new-model',
      inputPerMTok: 4,
      outputPerMTok: 8,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null
    }))
  })

  it('rejects an empty model id without calling the IPC', async () => {
    render(<ModelPricesDialog open onOpenChange={() => undefined} />)
    await screen.findByText('my-model')
    fireEvent.click(screen.getByRole('button', { name: /save price/i }))
    expect(await screen.findByText(/enter a model id/i)).toBeInTheDocument()
    expect(setModelPrice).not.toHaveBeenCalled()
  })

  it('resets a price via the row action', async () => {
    render(<ModelPricesDialog open onOpenChange={() => undefined} />)
    fireEvent.click(await screen.findByLabelText('Reset price for my-model'))
    await waitFor(() => expect(resetModelPrice).toHaveBeenCalledWith('my-model'))
  })

  it('clicking a row loads it back into the form for editing', async () => {
    render(<ModelPricesDialog open onOpenChange={() => undefined} />)
    fireEvent.click(await screen.findByText('my-model'))
    expect(screen.getByLabelText('Model id')).toHaveValue('my-model')
    expect(screen.getByLabelText('Input $/M tok')).toHaveValue(1)
    expect(screen.getByLabelText('Cache read $/M tok')).toHaveValue(0.5)
  })
})
