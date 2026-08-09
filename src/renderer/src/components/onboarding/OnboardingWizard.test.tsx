import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  OnboardingWizard,
  shouldShowOnboarding,
  isForceOnboarding,
  pickFreeModel
} from './OnboardingWizard'

// Access mock electronAPI from test/setup-renderer.ts
const mockAgentInstaller = window.electronAPI.agentInstaller as unknown as {
  detect: Mock
  install: Mock
  onProgress: Mock
}

const mockAgents = window.electronAPI.agents as unknown as {
  getAll: Mock
  create: Mock
  update: Mock
}

const mockSettings = window.electronAPI.settings as unknown as {
  get: Mock
  set: Mock
  getAll: Mock
}

const mockEnterprise = window.electronAPI.enterprise as unknown as {
  getSession: Mock
}

describe('pickFreeModel', () => {
  it.each([
    ['array model ID', [{ id: 'kimi-k2.5-free', name: 'Kimi K2.5' }], 'opencode/kimi-k2.5-free'],
    ['object-map key', { 'kimi-k2.5-free': { name: 'Kimi K2.5' } }, 'opencode/kimi-k2.5-free'],
    ['explicit object-map ID', { alias: { id: 'model-free' } }, 'opencode/model-free'],
    ['display name', [{ id: 'model-1', name: 'Community Free Model' }], 'opencode/model-1']
  ])('detects a free model from its %s', (_, models, expected) => {
    expect(pickFreeModel('opencode', models)).toBe(expected)
  })

  it('returns null when no free model exists', () => {
    expect(pickFreeModel('opencode', { 'paid-model': { name: 'Paid Model' } })).toBeNull()
  })
})

describe('shouldShowOnboarding', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('should return true when no completed version exists', () => {
    expect(shouldShowOnboarding(null, '1.0.0')).toBe(true)
    expect(shouldShowOnboarding(undefined, '1.0.0')).toBe(true)
  })

  it('should return false when major.minor matches', () => {
    expect(shouldShowOnboarding('1.2.0', '1.2.5')).toBe(false)
  })

  it('should return true when major version changes', () => {
    expect(shouldShowOnboarding('1.2.0', '2.2.0')).toBe(true)
  })

  it('should return true when minor version changes', () => {
    expect(shouldShowOnboarding('1.2.0', '1.3.0')).toBe(true)
  })

  it('should return true when force-onboarding flag is set', () => {
    localStorage.setItem('force-onboarding', 'true')
    expect(shouldShowOnboarding('1.2.0', '1.2.0')).toBe(true)
  })

  it('should return true when debug:onboarding flag is set', () => {
    localStorage.setItem('debug:onboarding', 'true')
    expect(shouldShowOnboarding('1.2.0', '1.2.0')).toBe(true)
  })
})

describe('isForceOnboarding', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('should return false by default', () => {
    expect(isForceOnboarding()).toBe(false)
  })

  it('should return true when force-onboarding is set', () => {
    localStorage.setItem('force-onboarding', 'true')
    expect(isForceOnboarding()).toBe(true)
  })

  it('should return true when debug:onboarding is set', () => {
    localStorage.setItem('debug:onboarding', 'true')
    expect(isForceOnboarding()).toBe(true)
  })
})

describe('OnboardingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()

    mockAgentInstaller.detect.mockResolvedValue({
      nodejs: { installed: true, version: '20.0.0' },
      npm: { installed: true, version: '10.0.0' },
      git: { installed: true, version: '2.40.0' },
      claudeCode: { installed: true, version: '1.0.0' },
      opencode: { installed: false, version: null },
      codex: { installed: false, version: null }
    })
    mockAgentInstaller.onProgress.mockImplementation(() => vi.fn())
    mockAgents.getAll.mockResolvedValue([])
    mockSettings.getAll.mockResolvedValue({})
    mockEnterprise.getSession.mockResolvedValue({
      isAuthenticated: false,
      userEmail: null,
      userId: null,
      currentTenant: null
    })
  })

  it('should not render when open is false', () => {
    render(<OnboardingWizard open={false} onOpenChange={vi.fn()} />)
    expect(screen.queryByText('Welcome to 20x')).not.toBeInTheDocument()
  })

  it('should render welcome title when open', () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    // Radix Dialog may render duplicate nodes
    expect(screen.getAllByText('Welcome to 20x').length).toBeGreaterThan(0)
  })

  it('should display Peakflo option prominently', () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    expect(screen.getAllByText('Peakflo').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Managed agents, workflows/i).length).toBeGreaterThan(0)
  })

  it('should display all three BYO coding agent options', () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0)
    expect(screen.getAllByText('OpenCode').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Codex').length).toBeGreaterThan(0)
  })

  it('should show button disabled when no agent is selected', () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    const btns = screen.getAllByRole('button', { name: /get started|sign up/i })
    expect(btns.some((b) => b.hasAttribute('disabled'))).toBe(true)
  })

  it('should show "Sign up / Log in" when Peakflo is selected', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    const peakfloButtons = screen.getAllByText('Peakflo')
    fireEvent.click(peakfloButtons[0])

    await waitFor(() => {
      expect(screen.getAllByText(/Sign up \/ Log in/i).length).toBeGreaterThan(0)
    })
  })

  it('should show "Get Started" when a BYO agent is selected', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    const agents = screen.getAllByText('Claude Code')
    fireEvent.click(agents[0])

    await waitFor(() => {
      // Button contains "Get Started" text alongside icon elements
      const btns = screen.getAllByText('Get Started')
      expect(btns.length).toBeGreaterThan(0)
    })
  })

  it('should call onOpenChange(false) when Skip is clicked', () => {
    const onOpenChange = vi.fn()
    render(<OnboardingWizard open={true} onOpenChange={onOpenChange} />)
    const skipBtns = screen.getAllByRole('button', { name: /skip/i })
    fireEvent.click(skipBtns[0])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('should detect tools on mount', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    await waitFor(() => {
      expect(mockAgentInstaller.detect).toHaveBeenCalled()
    })
  })

  it('should show git provider options when BYO agent is selected', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    const agents = screen.getAllByText('OpenCode')
    fireEvent.click(agents[0])

    await waitFor(() => {
      expect(screen.getAllByText(/Where are your repos/i).length).toBeGreaterThan(0)
      expect(screen.getAllByText('GitHub').length).toBeGreaterThan(0)
      expect(screen.getAllByText('GitLab').length).toBeGreaterThan(0)
    })
  })

  it('should NOT show git provider when Peakflo is selected', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    const peakflo = screen.getAllByText('Peakflo')
    fireEvent.click(peakflo[0])

    // Git provider row should not appear for Peakflo
    await waitFor(() => {
      expect(screen.queryByText(/Where are your repos/i)).not.toBeInTheDocument()
    })
  })

  it('should enable Get Started button when BYO agent is selected and not blocked', async () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)

    // Select Claude Code (which is installed per mock)
    const agents = screen.getAllByText('Claude Code')
    fireEvent.click(agents[0])

    // The Get Started button should appear and be enabled (agent is installed, no blocking)
    await waitFor(() => {
      const getStarted = screen.getAllByText('Get Started')
      const btn = getStarted[0].closest('button')
      expect(btn).toBeTruthy()
      expect(btn!.hasAttribute('disabled')).toBe(false)
    })
  })

  it('should show agent taglines', () => {
    render(<OnboardingWizard open={true} onOpenChange={vi.fn()} />)
    expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Open-source, free models').length).toBeGreaterThan(0)
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0)
  })
})
