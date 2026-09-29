import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { HeroSection } from './HeroSection'
import { useAgentStore, type AgentMessage, type TaskSession, SessionStatus } from '@/stores/agent-store'

afterEach(cleanup)

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'm-' + Math.random().toString(36).slice(2),
    role: 'assistant',
    content: 'Hello',
    timestamp: new Date('2026-01-01T10:00:00Z'),
    ...overrides
  }
}

function makeSession(messages: AgentMessage[]): TaskSession {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    taskId: 'mastermind-session',
    status: SessionStatus.IDLE,
    messages,
    pendingApproval: null
  }
}

function setMessages(messages: AgentMessage[]) {
  useAgentStore.setState({ sessions: new Map([['mastermind-session', makeSession(messages)]]) })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  useAgentStore.setState({ sessions: new Map() })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HeroSection', () => {
  it('renders the first rotating title by default', () => {
    render(<HeroSection onSeeFullConversation={vi.fn()} />)

    expect(screen.getByText('What do you want to finish today?')).toBeDefined()
  })

  it('rotates the title every 5 seconds and wraps around', () => {
    render(<HeroSection onSeeFullConversation={vi.fn()} />)

    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText('What should we tackle next?')).toBeDefined()

    act(() => { vi.advanceTimersByTime(5000 * 2) })
    expect(screen.getByText('What’s on your mind?')).toBeDefined()

    // Wraps back to the first title
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText('What do you want to finish today?')).toBeDefined()
  })

  it('renders nothing but the title when there is no mastermind session', () => {
    render(<HeroSection onSeeFullConversation={vi.fn()} />)

    expect(screen.queryByText('See full conversation')).toBeNull()
  })

  it('shows the last 3 text messages', () => {
    setMessages([
      makeMessage({ id: 'm1', role: 'user', content: 'First question' }),
      makeMessage({ id: 'm2', role: 'assistant', content: 'First answer' }),
      makeMessage({ id: 'm3', role: 'user', content: 'Second question' }),
      makeMessage({ id: 'm4', role: 'assistant', content: 'Second answer' })
    ])

    render(<HeroSection onSeeFullConversation={vi.fn()} />)

    expect(screen.queryByText('First question')).toBeNull()
    expect(screen.getByText('First answer')).toBeDefined()
    expect(screen.getByText('Second question')).toBeDefined()
    expect(screen.getByText('Second answer')).toBeDefined()
  })

  it('filters out tool/part and blank messages', () => {
    setMessages([
      makeMessage({ id: 'm1', content: 'Visible' }),
      makeMessage({ id: 'm2', content: 'Tool call', partType: 'tool_call' }),
      makeMessage({ id: 'm3', role: 'system', content: 'System note' }),
      makeMessage({ id: 'm4', content: '   \n  ' })
    ])

    render(<HeroSection onSeeFullConversation={vi.fn()} />)

    expect(screen.getByText('Visible')).toBeDefined()
    expect(screen.queryByText('Tool call')).toBeNull()
    expect(screen.queryByText('System note')).toBeNull()
  })

  it('collapses newlines in message content', () => {
    setMessages([makeMessage({ content: 'Line one\nLine two' })])

    render(<HeroSection onSeeFullConversation={vi.fn()} />)

    expect(screen.getByText('Line one Line two')).toBeDefined()
  })

  it('calls onSeeFullConversation when the button is clicked', () => {
    const onSeeFullConversation = vi.fn()
    setMessages([makeMessage({ content: 'A message' })])

    render(<HeroSection onSeeFullConversation={onSeeFullConversation} />)
    fireEvent.click(screen.getByText('See full conversation'))

    expect(onSeeFullConversation).toHaveBeenCalledTimes(1)
  })
})
