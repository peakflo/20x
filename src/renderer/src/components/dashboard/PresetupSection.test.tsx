import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { PresetupSection } from './PresetupSection'
import { useDashboardStore, type PresetupTemplate } from '@/stores/dashboard-store'

const mockSettingsGet = vi.fn().mockResolvedValue(null)
const mockSettingsSet = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/ipc-client', () => ({
  enterpriseApi: {
    apiRequest: vi.fn().mockResolvedValue({})
  },
  settingsApi: {
    get: (...args: unknown[]) => mockSettingsGet(...args),
    set: (...args: unknown[]) => mockSettingsSet(...args),
    getAll: vi.fn().mockResolvedValue({})
  }
}))

afterEach(cleanup)

function makeTemplate(overrides: Partial<PresetupTemplate> = {}): PresetupTemplate {
  return {
    slug: 'test-template',
    name: 'Test Template',
    description: 'A test template',
    category: 'finance',
    icon: 'Calculator',
    isProvisioned: false,
    provisionedAt: null,
    provisionStatus: null,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettingsGet.mockResolvedValue(null)
  useDashboardStore.setState({
    presetupTemplates: [makeTemplate()],
    presetupLoading: false
  })
})

describe('PresetupSection', () => {
  it('renders templates when expanded (default)', async () => {
    render(<PresetupSection />)
    await waitFor(() => {
      expect(screen.getByText('Get Started')).toBeDefined()
      expect(screen.getByText('Test Template')).toBeDefined()
    })
  })

  it('collapses when header is clicked', async () => {
    render(<PresetupSection />)
    await waitFor(() => expect(screen.getByText('Test Template')).toBeDefined())

    fireEvent.click(screen.getByText('Get Started'))

    expect(screen.queryByText('Test Template')).toBeNull()
    expect(mockSettingsSet).toHaveBeenCalledWith('dashboard_presetup_collapsed', 'true')
  })

  it('expands when header is clicked again', async () => {
    render(<PresetupSection />)
    await waitFor(() => expect(screen.getByText('Test Template')).toBeDefined())

    // Collapse
    fireEvent.click(screen.getByText('Get Started'))
    expect(screen.queryByText('Test Template')).toBeNull()

    // Expand
    fireEvent.click(screen.getByText('Get Started'))
    expect(screen.getByText('Test Template')).toBeDefined()
    expect(mockSettingsSet).toHaveBeenCalledWith('dashboard_presetup_collapsed', 'false')
  })

  it('restores collapsed state from settings', async () => {
    mockSettingsGet.mockResolvedValue('true')

    render(<PresetupSection />)

    await waitFor(() => {
      expect(screen.getByText('Get Started')).toBeDefined()
      expect(screen.queryByText('Test Template')).toBeNull()
    })
  })

  it('shows provisioned count when collapsed', async () => {
    useDashboardStore.setState({
      presetupTemplates: [
        makeTemplate({ slug: 'a', name: 'Template A', isProvisioned: true }),
        makeTemplate({ slug: 'b', name: 'Template B', isProvisioned: false })
      ]
    })
    mockSettingsGet.mockResolvedValue('true')

    render(<PresetupSection />)

    await waitFor(() => {
      expect(screen.getByText('1/2 set up')).toBeDefined()
    })
  })

  it('does not show provisioned count when expanded', async () => {
    useDashboardStore.setState({
      presetupTemplates: [
        makeTemplate({ slug: 'a', name: 'Template A', isProvisioned: true }),
        makeTemplate({ slug: 'b', name: 'Template B' })
      ]
    })

    render(<PresetupSection />)
    await waitFor(() => expect(screen.getByText('Template A')).toBeDefined())

    expect(screen.queryByText('1/2 set up')).toBeNull()
  })

  it('renders nothing when no templates', async () => {
    useDashboardStore.setState({ presetupTemplates: [] })

    const { container } = render(<PresetupSection />)
    await waitFor(() => expect(mockSettingsGet).toHaveBeenCalled())

    expect(container.innerHTML).toBe('')
  })

  it('shows loading skeleton while presetupLoading', () => {
    useDashboardStore.setState({ presetupLoading: true })

    render(<PresetupSection />)
    expect(screen.getByText('Get Started')).toBeDefined()
    // Template cards should not be rendered during loading
    expect(screen.queryByText('Test Template')).toBeNull()
  })
})
