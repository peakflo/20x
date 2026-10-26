import { describe, expect, it } from 'vitest'
import { reuseUnchangedDurations } from './use-task-run-durations'

describe('reuseUnchangedDurations', () => {
  it('returns the previous map when nothing changed', () => {
    const prev = { a: { durationMs: 1000, isRunning: false } }
    expect(reuseUnchangedDurations(prev, { a: { durationMs: 1000, isRunning: false } })).toBe(prev)
  })

  it('keeps unchanged entries and takes changed or new ones', () => {
    const prev = { a: { durationMs: 1000, isRunning: false }, b: { durationMs: 5000, isRunning: true } }
    const next = { a: { durationMs: 1000, isRunning: false }, b: { durationMs: 10000, isRunning: true }, c: { durationMs: 1, isRunning: true } }
    const merged = reuseUnchangedDurations(prev, next)
    expect(merged).not.toBe(prev)
    expect(merged.a).toBe(prev.a)
    expect(merged.b).toBe(next.b)
    expect(merged.c).toBe(next.c)
  })

  it('drops entries that are no longer returned', () => {
    const prev = { a: { durationMs: 1000, isRunning: false }, b: { durationMs: 2000, isRunning: false } }
    const merged = reuseUnchangedDurations(prev, { a: { durationMs: 1000, isRunning: false } })
    expect(merged).toEqual({ a: prev.a })
    expect(merged.a).toBe(prev.a)
  })
})
