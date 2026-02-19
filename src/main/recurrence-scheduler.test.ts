import { describe, it, expect } from 'vitest'
import { RecurrenceScheduler } from './recurrence-scheduler'

// Minimal mock — we only need calculateNextOccurrence (no DB access)
const scheduler = new RecurrenceScheduler({} as any)

describe('RecurrenceScheduler.calculateNextOccurrence', () => {
  describe('cron strings', () => {
    it('daily at 9am: next day', () => {
      const result = scheduler.calculateNextOccurrence(
        '0 9 * * *',
        '2024-01-15T09:00:00.000Z'
      )
      expect(result).toBe('2024-01-16T09:00:00.000Z')
    })

    it('every-other-day cron */2', () => {
      const result = scheduler.calculateNextOccurrence(
        '0 9 */2 * *',
        '2024-01-15T09:00:00.000Z'
      )
      // */2 means day 1,3,5,...  next after Jan 15 is Jan 17
      expect(result).not.toBeNull()
      const next = new Date(result!)
      expect(next.getUTCHours()).toBe(9)
      expect(next.getUTCMinutes()).toBe(0)
      expect(next > new Date('2024-01-15T09:00:00.000Z')).toBe(true)
    })

    it('weekly Mon/Wed/Fri at 14:00', () => {
      // Jan 15 2024 is a Monday
      const result = scheduler.calculateNextOccurrence(
        '0 14 * * 1,3,5',
        '2024-01-15T14:00:00.000Z'
      )
      expect(result).not.toBeNull()
      const next = new Date(result!)
      // Next after Mon 14:00 should be Wed Jan 17
      expect(next.getUTCDay()).toBe(3) // Wednesday
      expect(next.getUTCHours()).toBe(14)
    })

    it('weekdays (Mon-Fri) at 9am', () => {
      // Jan 19 2024 is a Friday
      const result = scheduler.calculateNextOccurrence(
        '0 9 * * 1-5',
        '2024-01-19T09:00:00.000Z'
      )
      expect(result).not.toBeNull()
      const next = new Date(result!)
      // Next weekday after Friday is Monday Jan 22
      expect(next.getUTCDay()).toBe(1) // Monday
      expect(next.toISOString()).toBe('2024-01-22T09:00:00.000Z')
    })

    it('monthly on 15th at 10:00', () => {
      const result = scheduler.calculateNextOccurrence(
        '0 10 15 * *',
        '2024-01-15T10:00:00.000Z'
      )
      expect(result).toBe('2024-02-15T10:00:00.000Z')
    })

    it('invalid cron returns null', () => {
      const result = scheduler.calculateNextOccurrence(
        'not a cron',
        '2024-01-15T09:00:00.000Z'
      )
      expect(result).toBeNull()
    })

    it('empty cron treated as every-minute (cron-parser default)', () => {
      const result = scheduler.calculateNextOccurrence(
        '',
        '2024-01-15T09:00:00.000Z'
      )
      // cron-parser treats empty string as "* * * * *"
      expect(result).not.toBeNull()
    })
  })

  describe('legacy JSON patterns', () => {
    it('daily pattern: interval=1', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'daily', interval: 1, time: '09:00' },
        '2024-01-15T09:00:00.000Z'
      )
      expect(result).not.toBeNull()
      const next = new Date(result!)
      expect(next.getDate()).toBe(16)
    })

    it('daily pattern: interval=3', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'daily', interval: 3, time: '09:00' },
        '2024-01-15T09:00:00.000Z'
      )
      expect(result).not.toBeNull()
      const next = new Date(result!)
      expect(next.getDate()).toBe(18)
    })

    it('weekly pattern: Mon/Wed/Fri', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'weekly', interval: 1, time: '14:00', weekdays: [1, 3, 5] },
        '2024-01-15T14:00:00.000Z' // Monday
      )
      expect(result).not.toBeNull()
      const next = new Date(result!)
      expect(next.getDay()).toBe(3) // Wednesday
    })

    it('weekly pattern with no weekdays returns null', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'weekly', interval: 1, time: '14:00', weekdays: [] },
        '2024-01-15T14:00:00.000Z'
      )
      expect(result).toBeNull()
    })

    it('monthly pattern: 15th', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'monthly', interval: 1, time: '10:00', monthDay: 15 },
        '2024-01-15T10:00:00.000Z'
      )
      expect(result).not.toBeNull()
      const next = new Date(result!)
      expect(next.getMonth()).toBe(1) // February
      expect(next.getDate()).toBe(15)
    })

    it('monthly pattern: monthDay 15 starting from Jan', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'monthly', interval: 1, time: '10:00', monthDay: 15 },
        '2024-01-10T10:00:00.000Z'
      )
      expect(result).not.toBeNull()
      const next = new Date(result!)
      expect(next.getMonth()).toBe(1) // February
      expect(next.getDate()).toBe(15)
    })

    it('endDate constraint: returns null if next exceeds endDate', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'daily', interval: 1, time: '09:00', endDate: '2024-01-15T23:59:59.000Z' },
        '2024-01-15T09:00:00.000Z'
      )
      expect(result).toBeNull()
    })

    it('endDate constraint: returns date if within endDate', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'daily', interval: 1, time: '09:00', endDate: '2024-01-20T23:59:59.000Z' },
        '2024-01-15T09:00:00.000Z'
      )
      expect(result).not.toBeNull()
    })

    it('custom type falls back to daily interval', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'custom', interval: 2, time: '09:00' },
        '2024-01-15T09:00:00.000Z'
      )
      expect(result).not.toBeNull()
      const next = new Date(result!)
      expect(next.getDate()).toBe(17)
    })

    it('unknown type returns null', () => {
      const result = scheduler.calculateNextOccurrence(
        { type: 'unknown' as any, interval: 1, time: '09:00' },
        '2024-01-15T09:00:00.000Z'
      )
      expect(result).toBeNull()
    })
  })

  describe('fast-forward (simulated backfill)', () => {
    it('can advance through multiple cron occurrences to find future time', () => {
      // Simulate app offline for 3 days with daily 9am cron
      const cron = '0 9 * * *'
      const missedStart = '2024-01-15T09:00:00.000Z'
      const now = new Date('2024-01-18T14:00:00.000Z') // Thu 2pm

      let next: string | null = missedStart
      let iterations = 0
      while (next && new Date(next) <= now && iterations < 100) {
        next = scheduler.calculateNextOccurrence(cron, next)
        iterations++
      }

      expect(next).not.toBeNull()
      expect(new Date(next!).toISOString()).toBe('2024-01-19T09:00:00.000Z')
      expect(iterations).toBe(4) // Mon→Tue→Wed→Thu→Fri
    })
  })
})
