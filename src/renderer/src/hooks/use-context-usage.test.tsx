import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useContextUsage } from './use-context-usage'
import type { ContextUsageSnapshot } from '@shared/context-usage'

type Listener = (snapshot: ContextUsageSnapshot) => void

let listener: Listener | null = null
const unsubscribe = vi.fn()
const getContextUsage = vi.fn()

function snapshot(taskId: string, usedTokens: number): ContextUsageSnapshot {
  return {
    taskId,
    agentId: null,
    codingAgent: 'claude-code',
    usedTokens,
    maxTokens: 200_000,
    percent: (usedTokens / 200_000) * 100,
    model: null,
    compacting: false,
    canCompact: true,
    updatedAt: '2026-10-05T10:00:00.000Z'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  listener = null
  const api = window.electronAPI.agentSession as unknown as Record<string, unknown>
  api.getContextUsage = getContextUsage
  api.onContextUsage = vi.fn((cb: Listener) => {
    listener = cb
    return unsubscribe
  })
})

describe('useContextUsage', () => {
  it('returns null without a task id and does not subscribe', () => {
    const { result } = renderHook(() => useContextUsage(undefined))

    expect(result.current).toBeNull()
    expect(getContextUsage).not.toHaveBeenCalled()
  })

  it('hydrates from the initial read for the task', async () => {
    getContextUsage.mockResolvedValue(snapshot('task-1', 50_000))

    const { result } = renderHook(() => useContextUsage('task-1'))

    await waitFor(() => expect(result.current?.usedTokens).toBe(50_000))
    expect(getContextUsage).toHaveBeenCalledWith('task-1')
  })

  it('applies live pushes for its task and ignores other tasks', async () => {
    getContextUsage.mockResolvedValue(null)

    const { result } = renderHook(() => useContextUsage('task-1'))
    await waitFor(() => expect(getContextUsage).toHaveBeenCalled())

    act(() => listener?.(snapshot('task-2', 999)))
    expect(result.current).toBeNull()

    act(() => listener?.(snapshot('task-1', 120_000)))
    expect(result.current?.usedTokens).toBe(120_000)
  })

  it('keeps a live push that beats a slower initial read', async () => {
    let resolveRead: (value: ContextUsageSnapshot) => void = () => {}
    getContextUsage.mockReturnValue(new Promise<ContextUsageSnapshot>((resolve) => { resolveRead = resolve }))

    const { result } = renderHook(() => useContextUsage('task-1'))
    act(() => listener?.(snapshot('task-1', 160_000)))
    await act(async () => resolveRead(snapshot('task-1', 10_000)))

    expect(result.current?.usedTokens).toBe(160_000)
  })

  it('does not leak a snapshot across a task change and ignores stale reads', async () => {
    let resolveFirst: (value: ContextUsageSnapshot) => void = () => {}
    getContextUsage.mockReturnValueOnce(new Promise<ContextUsageSnapshot>((resolve) => { resolveFirst = resolve }))
    getContextUsage.mockResolvedValueOnce(snapshot('task-2', 30_000))

    const { result, rerender } = renderHook(({ taskId }: { taskId: string }) => useContextUsage(taskId), {
      initialProps: { taskId: 'task-1' }
    })
    rerender({ taskId: 'task-2' })
    await waitFor(() => expect(result.current?.usedTokens).toBe(30_000))

    await act(async () => resolveFirst(snapshot('task-1', 1)))
    expect(result.current?.taskId).toBe('task-2')
    expect(result.current?.usedTokens).toBe(30_000)
  })

  it('unsubscribes on unmount', () => {
    getContextUsage.mockResolvedValue(null)

    const { unmount } = renderHook(() => useContextUsage('task-1'))
    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
