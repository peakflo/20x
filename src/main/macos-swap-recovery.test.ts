import { describe, expect, it, vi } from 'vitest'
import { isSwapSuspensionLog, MacosSwapRecovery, SWAP_DISK_RECOVERED_BYTES, SWAP_HEARTBEAT_TIMEOUT_MS } from './macos-swap-recovery'

function fixture() {
  let now = 1_000_000
  const deps = {
    now: () => now,
    freeBytes: vi.fn(async () => SWAP_DISK_RECOVERED_BYTES),
    wasSuspended: vi.fn(async (_since: number) => true),
    isParent: vi.fn(() => true),
    resume: vi.fn(),
    send: vi.fn()
  }
  const recovery = new MacosSwapRecovery(deps)
  return { deps, recovery, advance: (ms = SWAP_HEARTBEAT_TIMEOUT_MS) => { now += ms } }
}

describe('macOS swap suspension recovery', () => {
  it('resumes after confirmed swap suspension and two recovered disk readings', async () => {
    const { deps, recovery, advance } = fixture()
    await recovery.check()
    advance()
    await recovery.check()
    expect(deps.wasSuspended).toHaveBeenCalledWith(1_000_000)
    expect(deps.resume).not.toHaveBeenCalled()
    await recovery.check()
    expect(deps.resume).toHaveBeenCalledOnce()
    expect(deps.send).toHaveBeenLastCalledWith({ type: 'resumed', freeBytes: SWAP_DISK_RECOVERED_BYTES })
    await recovery.check()
    expect(deps.resume).toHaveBeenCalledOnce()
  })

  it('does not continue a debugger pause or a slow main process without kernel evidence', async () => {
    const { deps, recovery, advance } = fixture()
    deps.wasSuspended.mockResolvedValue(false)
    await recovery.check()
    advance()
    for (let i = 0; i < 20; i++) await recovery.check()
    expect(deps.resume).not.toHaveBeenCalled()
    expect(deps.wasSuspended).toHaveBeenCalledOnce()
    expect(deps.send.mock.calls.filter(([m]) => m.type === 'ping')).toHaveLength(1)
  })

  it('warns once while critically low and waits for disk recovery before continuing', async () => {
    const { deps, recovery, advance } = fixture()
    deps.freeBytes.mockResolvedValue(100)
    await recovery.check()
    advance()
    await recovery.check()
    await recovery.check()
    expect(deps.send.mock.calls.filter(([m]) => m.type === 'low-disk')).toHaveLength(1)
    expect(deps.resume).not.toHaveBeenCalled()
    deps.freeBytes.mockResolvedValue(SWAP_DISK_RECOVERED_BYTES)
    await recovery.check()
    await recovery.check()
    expect(deps.resume).toHaveBeenCalledOnce()
  })

  it('requires stable recovery when disk space falls again', async () => {
    const { deps, recovery, advance } = fixture()
    advance()
    await recovery.check()
    deps.freeBytes.mockResolvedValue(0)
    await recovery.check()
    deps.freeBytes.mockResolvedValue(SWAP_DISK_RECOVERED_BYTES)
    await recovery.check()
    expect(deps.resume).not.toHaveBeenCalled()
    await recovery.check()
    expect(deps.resume).toHaveBeenCalledOnce()
  })

  it('discards a pending log result if main answered in the meantime', async () => {
    const { deps, recovery, advance } = fixture()
    let resolve!: (value: boolean) => void
    deps.wasSuspended.mockImplementation(() => new Promise<boolean>((r) => { resolve = r }))
    advance()
    const checking = recovery.check()
    await vi.waitFor(() => expect(deps.wasSuspended).toHaveBeenCalled())
    advance(10)
    recovery.pong()
    resolve(true)
    await checking
    await recovery.check()
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('does not signal a reused PID when the parent exits during the disk check', async () => {
    const { deps, recovery, advance } = fixture()
    advance()
    await recovery.check()
    deps.freeBytes.mockImplementation(async () => {
      deps.isParent.mockReturnValue(false)
      return SWAP_DISK_RECOVERED_BYTES
    })
    await recovery.check()
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('fails closed if the kernel log cannot be read', async () => {
    const { deps, recovery, advance } = fixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    deps.wasSuspended.mockRejectedValue(new Error('permission denied'))
    advance()
    await recovery.check()
    await recovery.check()
    expect(deps.resume).not.toHaveBeenCalled()
    warning.mockRestore()
  })

  it('does not resume after shutdown while a probe is pending', async () => {
    const { deps, recovery, advance } = fixture()
    advance()
    await recovery.check()
    deps.freeBytes.mockImplementation(async () => {
      recovery.stop()
      return SWAP_DISK_RECOVERED_BYTES
    })
    await recovery.check()
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('resets the recovery attempt on a heartbeat and can recover a later suspension', async () => {
    const { deps, recovery, advance } = fixture()
    advance()
    await recovery.check()
    await recovery.check()
    recovery.pong()
    advance()
    await recovery.check()
    await recovery.check()
    expect(deps.resume).toHaveBeenCalledTimes(2)
  })
})

describe('swap suspension evidence', () => {
  it('recognizes the observed kernel event for this PID', () => {
    expect(isSwapSuspensionLog('2026-10-24 10:31:05.040 Df kernel[0:48457b] [com.apple.xnu:memorystatus] memorystatus: memorystatus: suspending 20x [23638] due to swap exhaustion', 23638)).toBe(true)
  })

  it('rejects other processes, attempts, headers and ordinary disk failures', () => {
    expect(isSwapSuspensionLog('suspending 20x [23639] due to swap exhaustion', 23638)).toBe(false)
    expect(isSwapSuspensionLog('attempting pcontrol on [23638]', 23638)).toBe(false)
    expect(isSwapSuspensionLog('vnode_setsize for swap files failed: 28', 23638)).toBe(false)
    expect(isSwapSuspensionLog('Timestamp Ty Process[PID:TID]', 23638)).toBe(false)
  })
})
