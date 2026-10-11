import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { AcpAgentInstanceView } from '@shared/acp-registry'

const list = vi.fn()

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      acpInstances: { list: (...args: unknown[]) => list(...args) }
    }
  }
})

import { AcpAgentsSection } from './AcpAgentsSection'

const devin: AcpAgentInstanceView = {
  id: 'acp_devin',
  display_name: 'Devin',
  source: 'registry',
  registry_agent_id: 'devin',
  version: '1.2.3',
  distribution: 'auto',
  command_path: null,
  command_args: [],
  env: {},
  secret_ids: [],
  auth_method_id: null,
  custom_models: [],
  created_at: '2026-10-09T00:00:00.000Z'
}

beforeEach(() => {
  list.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('AcpAgentsSection (mobile, read-only)', () => {
  it('lists configured ACP instances with their source badge', async () => {
    list.mockResolvedValue([devin])
    render(<AcpAgentsSection />)

    const row = await screen.findByTestId('mobile-acp-instance-acp_devin')
    expect(row.textContent).toContain('Devin')
    expect(row.textContent).toContain('Registry')
    expect(screen.getByText(/desktop app/i)).toBeTruthy()
  })

  it('renders nothing while loading or when no instances are configured', async () => {
    list.mockResolvedValue([])
    const { container } = render(<AcpAgentsSection />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('renders nothing (fails closed) if the request errors, rather than showing an error state', async () => {
    list.mockRejectedValue(new Error('network error'))
    const { container } = render(<AcpAgentsSection />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
