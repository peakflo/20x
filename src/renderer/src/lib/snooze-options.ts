const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

export const SNOOZE_SOMEDAY = '9999-12-31T00:00:00.000Z'

export interface SnoozeOption {
  label: string
  description: string
  value: string
}

function nextDayAt8(daysFromNow: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  d.setHours(8, 0, 0, 0)
  return d
}

function nextWeekday(targetDay: number): Date {
  const now = new Date()
  const current = now.getDay()
  let diff = targetDay - current
  if (diff <= 0) diff += 7
  const d = new Date(now)
  d.setDate(d.getDate() + diff)
  d.setHours(8, 0, 0, 0)
  return d
}

function formatDescription(date: Date): string {
  return `${DAY_NAMES[date.getDay()]}, 8:00 AM`
}

export function getSnoozeOptions(): SnoozeOption[] {
  const tomorrow = nextDayAt8(1)
  const nextMonday = nextWeekday(1) // Monday
  const nextSaturday = nextWeekday(6) // Saturday

  return [
    {
      label: 'Tomorrow',
      description: formatDescription(tomorrow),
      value: tomorrow.toISOString()
    },
    {
      label: 'Next week',
      description: formatDescription(nextMonday),
      value: nextMonday.toISOString()
    },
    {
      label: 'This weekend',
      description: formatDescription(nextSaturday),
      value: nextSaturday.toISOString()
    },
    {
      label: 'Someday',
      description: '¯\\_(ツ)_/¯',
      value: SNOOZE_SOMEDAY
    }
  ]
}
