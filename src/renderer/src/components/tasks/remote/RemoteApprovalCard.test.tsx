import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPROVAL_TTL_MS } from '@shared/enterprise-runners'
import type { AgentMessage } from '@/hooks/use-agent-session'
import { RemoteApprovalCard } from './RemoteApprovalCard'
import { RemoteDecisionContext } from '@/hooks/use-remote-task-state'

function permission(createdAt: number): AgentMessage {
  return {
    id: 'p1', role: 'assistant', content: '', timestamp: new Date(createdAt), partType: 'question',
    tool: {
      name: 'permission', status: 'pending', description: 'git push origin fix/x',
      questions: [{ header: 'Permission', question: 'Run git push?', options: [
        { label: 'Allow', description: '' }, { label: 'Always allow', description: '' }, { label: 'Reject', description: '' }
      ] }]
    }
  } as AgentMessage
}

describe('RemoteApprovalCard', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T12:00:00Z')) })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('offers Allow / Reject only, never always-allow', () => {
    render(<RemoteApprovalCard message={permission(Date.now())} canAnswer onAnswer={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
    expect(screen.queryByText(/Always allow/)).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('Reject decides approved=false and Allow approved=true, never via free-text', () => {
    const decide = vi.fn()
    const onAnswer = vi.fn()
    const msg = { ...permission(Date.now()), tool: { ...permission(Date.now()).tool!, requestId: 'perm-1' } } as AgentMessage
    const { unmount } = render(<RemoteDecisionContext.Provider value={decide}><RemoteApprovalCard message={msg} canAnswer onAnswer={onAnswer} /></RemoteDecisionContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(decide).toHaveBeenCalledWith({ approved: false, requestId: 'perm-1', label: 'Reject' })
    unmount()
    render(<RemoteDecisionContext.Provider value={decide}><RemoteApprovalCard message={msg} canAnswer onAnswer={onAnswer} /></RemoteDecisionContext.Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(decide).toHaveBeenLastCalledWith({ approved: true, requestId: 'perm-1', label: 'Allow' })
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("treats \"Don't allow\" and unknown labels as reject", () => {
    const decide = vi.fn()
    const msg = { ...permission(Date.now()), tool: { name: 'permission', requestId: 'p', questions: [{ header: '', question: 'q', options: [{ label: "Don't allow" }, { label: 'Maybe' }] }] } } as unknown as AgentMessage
    render(<RemoteDecisionContext.Provider value={decide}><RemoteApprovalCard message={msg} canAnswer /></RemoteDecisionContext.Provider>)
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true) // no allow option offered
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ approved: false }))
  })

  it('counts down every second and expires after 30 minutes', () => {
    render(<RemoteApprovalCard message={permission(Date.now() - (APPROVAL_TTL_MS - 27 * 60_000 - 40_000))} canAnswer onAnswer={vi.fn()} />)
    expect(screen.getByTestId('approval-countdown').textContent).toContain('27:40')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByTestId('approval-countdown').textContent).toContain('27:39')
    act(() => { vi.advanceTimersByTime(28 * 60_000) })
    expect(screen.queryByTestId('approval-countdown')).toBeNull()
    expect(screen.getByText('Approval expired')).toBeTruthy()
    expect(screen.getByText(/Denied · timed out/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not answer once expired', () => {
    const onAnswer = vi.fn()
    render(<RemoteApprovalCard message={permission(Date.now() - APPROVAL_TTL_MS - 1000)} canAnswer onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('shows a countdown on questions too and times them out', () => {
    const q = { id: 'q', role: 'assistant', content: '', timestamp: new Date(Date.now() - APPROVAL_TTL_MS + 5000), partType: 'question', tool: { name: 'question', status: 'pending', questions: [{ header: 'Fix', question: 'Lock or idempotent?', options: [{ label: 'Lock per invoice', description: '' }, { label: 'Idempotent handler', description: '' }] }] } } as AgentMessage
    render(<RemoteApprovalCard message={q} canAnswer onAnswer={vi.fn()} />)
    expect(screen.getByTestId('approval-countdown').textContent).toContain('0:05')
    act(() => { vi.advanceTimersByTime(6000) })
    expect(screen.getByText(/Question expired/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /Lock per invoice/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
