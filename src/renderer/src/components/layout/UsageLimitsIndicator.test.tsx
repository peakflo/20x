import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProviderUsageLimits } from '@shared/usage'

let pushLimits: ((limits: ProviderUsageLimits) => void) | null = null
const getLimits = vi.fn()
const refreshLimits = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  usageApi: {
    getLimits: (...args: unknown[]) => getLimits(...args),
    refreshLimits: (...args: unknown[]) => refreshLimits(...args),
    getSummary: vi.fn(async () => null),
    setCursorKeychainAccess: vi.fn()
  },
  onUsageLimitsUpdated: (cb: (limits: ProviderUsageLimits) => void) => {
    pushLimits = cb
    return () => { pushLimits = null }
  },
  onUsageRecorded: () => () => undefined
}))

import { UsageLimitsIndicator } from './UsageLimitsIndicator'
import { useUsageStore } from '@/stores/usage-store'
import { useUIStore } from '@/stores/ui-store'
import { SettingsTab } from '@/types'

const inThreeHours = new Date(Date.now() + 3 * 60 * 60 * 1000 + 30_000).toISOString()

const claude: ProviderUsageLimits = {
  provider: 'claude-code',
  checkedAt: new Date().toISOString(),
  planType: 'max',
  windows: [
    { id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 35, resetsAt: inThreeHours, windowDurationMins: 300 },
    { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 82, resetsAt: null, windowDurationMins: 10_080 }
  ],
  unavailable: null
}

const codex: ProviderUsageLimits = {
  provider: 'codex',
  checkedAt: new Date().toISOString(),
  planType: 'pro',
  windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent: 12, resetsAt: inThreeHours, windowDurationMins: 300 }],
  unavailable: null
}

const unsupportedOpenCode: ProviderUsageLimits = {
  provider: 'opencode',
  checkedAt: new Date().toISOString(),
  windows: [],
  unavailable: { reason: 'unsupported', message: 'n/a' }
}

beforeEach(() => {
  cleanup()
  useUsageStore.setState({ limits: [], loaded: false, refreshing: false, error: null })
  getLimits.mockReset().mockResolvedValue([claude, codex, unsupportedOpenCode])
  refreshLimits.mockReset().mockResolvedValue({ limits: [claude, codex, unsupportedOpenCode], refreshed: [] })
})

describe('UsageLimitsIndicator', () => {
  it('shows the most constrained window per provider and hides providers without readings', async () => {
    render(<UsageLimitsIndicator />)

    const claudeChip = await screen.findByRole('button', { name: /Claude: 82% of weekly limit used/ })
    expect(claudeChip).toHaveTextContent('Claude')
    expect(claudeChip).toHaveTextContent('82%')
    expect(claudeChip.className).toContain('text-warning')
    expect(screen.getByRole('button', { name: /Codex: 12% of 5-hour limit used, resets in 3h 0m/ })).toBeInTheDocument()
    expect(screen.queryByTestId('usage-chip-opencode')).not.toBeInTheDocument()
  })

  it('shows the full breakdown on hover', async () => {
    render(<UsageLimitsIndicator />)
    const chip = await screen.findByTestId('usage-chip-claude-code')
    fireEvent.mouseEnter(chip)
    const card = screen.getByTestId('usage-limits-claude-code')
    expect(card).toHaveTextContent('Max')
    expect(card).toHaveTextContent('35% used · resets in 3h 0m')
    expect(card).toHaveTextContent('82% used')
    fireEvent.mouseLeave(chip)
    expect(screen.queryByTestId('usage-limits-claude-code')).not.toBeInTheDocument()
  })

  it('opens Settings → Usage on click', async () => {
    render(<UsageLimitsIndicator />)
    fireEvent.click(await screen.findByRole('button', { name: /Codex:/ }))
    expect(useUIStore.getState().settingsTab).toBe(SettingsTab.USAGE)
    expect(useUIStore.getState().activeModal).toBe('settings')
  })

  it('updates live and flags a reached limit', async () => {
    render(<UsageLimitsIndicator />)
    await screen.findByTestId('usage-chip-codex')
    act(() => {
      pushLimits?.({ ...codex, limitReached: true, windows: [{ ...codex.windows[0], usedPercent: 100 }] })
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /Codex: 100%/ }).className).toContain('text-destructive'))
  })

  it('renders nothing when no provider reports limits', async () => {
    getLimits.mockResolvedValue([unsupportedOpenCode])
    refreshLimits.mockResolvedValue({ limits: [unsupportedOpenCode], refreshed: [] })
    const { container } = render(<UsageLimitsIndicator />)
    await waitFor(() => expect(refreshLimits).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
