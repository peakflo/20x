import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cn, formatDate, formatRelativeDate, isOverdue, isDueSoon } from './utils'

describe('cn()', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible')
  })

  it('deduplicates conflicting tailwind classes', () => {
    const result = cn('px-2', 'px-4')
    expect(result).toBe('px-4')
  })

  it('returns empty string for no inputs', () => {
    expect(cn()).toBe('')
  })
})

describe('formatDate()', () => {
  it('returns empty string for null', () => {
    expect(formatDate(null)).toBe('')
  })

  it('formats a valid date string', () => {
    const result = formatDate('2024-03-15')
    expect(result).toMatch(/Mar/)
    expect(result).toMatch(/15/)
    expect(result).toMatch(/2024/)
  })
})

describe('formatRelativeDate()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "Just now" for less than 1 minute ago', () => {
    const date = new Date('2024-06-15T11:59:30Z').toISOString()
    expect(formatRelativeDate(date)).toBe('Just now')
  })

  it('returns minutes ago for less than 1 hour', () => {
    const date = new Date('2024-06-15T11:30:00Z').toISOString()
    expect(formatRelativeDate(date)).toBe('30m ago')
  })

  it('returns hours ago for less than 24 hours', () => {
    const date = new Date('2024-06-15T06:00:00Z').toISOString()
    expect(formatRelativeDate(date)).toBe('6h ago')
  })

  it('returns days ago for less than 7 days', () => {
    const date = new Date('2024-06-12T12:00:00Z').toISOString()
    expect(formatRelativeDate(date)).toBe('3d ago')
  })

  it('falls back to formatDate for 7+ days ago', () => {
    const date = new Date('2024-06-01T12:00:00Z').toISOString()
    const result = formatRelativeDate(date)
    expect(result).toMatch(/Jun/)
    expect(result).toMatch(/1/)
    expect(result).toMatch(/2024/)
  })
})

describe('isOverdue()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false for null', () => {
    expect(isOverdue(null)).toBe(false)
  })

  it('returns true for a past date', () => {
    expect(isOverdue('2024-06-14')).toBe(true)
  })

  it('returns false for today', () => {
    expect(isOverdue('2024-06-15')).toBe(false)
  })

  it('returns false for a future date', () => {
    expect(isOverdue('2024-06-16')).toBe(false)
  })
})

describe('isDueSoon()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false for null', () => {
    expect(isDueSoon(null)).toBe(false)
  })

  it('returns true for today', () => {
    expect(isDueSoon('2024-06-15')).toBe(true)
  })

  it('returns true for tomorrow', () => {
    expect(isDueSoon('2024-06-16')).toBe(true)
  })

  it('returns false for a past date', () => {
    expect(isDueSoon('2024-06-14')).toBe(false)
  })

  it('returns false for 2+ days in the future', () => {
    expect(isDueSoon('2024-06-17')).toBe(false)
  })
})
