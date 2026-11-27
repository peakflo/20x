import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { RemoteApprovalCard } from './RemoteApprovalCard'
import { APPROVAL_TTL_MS } from '@shared/enterprise-runners'

afterEach(() => { cleanup(); vi.useRealTimers() })

const base = { kind: 'approval' as const, text: 'git push origin fix/x', requestedAtMs: 1_000_000 }

describe('RemoteApprovalCard', () => {
  it('counts down every second from 30 minutes', () => {
    vi.useFakeTimers()
    let t = base.requestedAtMs
    render(<RemoteApprovalCard request={base} onAllow={vi.fn()} onReject={vi.fn()} onPick={vi.fn()} now={() => t} />)
    expect(screen.getByTestId('approval-countdown').textContent).toContain('30:00')
    t += 5000
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByTestId('approval-countdown').textContent).toContain('29:55')
  })

  it('offers Allow and Reject only, never "always allow"', () => {
    const onAllow = vi.fn(); const onReject = vi.fn()
    render(<RemoteApprovalCard request={base} onAllow={onAllow} onReject={onReject} onPick={vi.fn()} now={() => base.requestedAtMs} />)
    const buttons = screen.getAllByRole('button').map((b) => b.textContent)
    expect(buttons).toEqual(['Allow', 'Reject'])
    fireEvent.click(screen.getByText('Allow')); fireEvent.click(screen.getByText('Reject'))
    expect(onAllow).toHaveBeenCalled(); expect(onReject).toHaveBeenCalled()
  })

  it('drops "always allow" question options', () => {
    render(<RemoteApprovalCard request={{ ...base, kind: 'question', options: [{ label: 'Lock per invoice' }, { label: 'Always allow' }] }} onAllow={vi.fn()} onReject={vi.fn()} onPick={vi.fn()} now={() => base.requestedAtMs} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Lock per invoice'])
  })

  it('shows "Approval expired" with no actions after 30 minutes', () => {
    render(<RemoteApprovalCard request={base} onAllow={vi.fn()} onReject={vi.fn()} onPick={vi.fn()} now={() => base.requestedAtMs + APPROVAL_TTL_MS} />)
    expect(screen.getByText(/Approval expired/)).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByTestId('approval-countdown')).toBeNull()
  })
})
