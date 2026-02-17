import { useState, useEffect } from 'react'
import type { RecurrencePattern } from '../../types'
import { Label } from '../ui/Label'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { Button } from '../ui/Button'

interface RecurrenceEditorProps {
  value: RecurrencePattern | null
  onChange: (pattern: RecurrencePattern | null) => void
}

const WEEKDAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' }
]

const FREQUENCY_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }
]

export function RecurrenceEditor({ value, onChange }: RecurrenceEditorProps) {
  const [enabled, setEnabled] = useState(!!value)
  const [type, setType] = useState<RecurrencePattern['type']>(value?.type || 'daily')
  const [interval, setInterval] = useState(value?.interval || 1)
  const [time, setTime] = useState(value?.time || '09:00')
  const [weekdays, setWeekdays] = useState<number[]>(value?.weekdays || [1, 2, 3, 4, 5]) // Mon-Fri default
  const [monthDay, setMonthDay] = useState(value?.monthDay || 1)
  const [endDate, setEndDate] = useState(value?.endDate || '')

  useEffect(() => {
    if (!enabled) {
      onChange(null)
      return
    }

    const pattern: RecurrencePattern = {
      type,
      interval,
      time
    }

    if (type === 'weekly') {
      pattern.weekdays = weekdays
    } else if (type === 'monthly') {
      pattern.monthDay = monthDay
    }

    if (endDate) {
      pattern.endDate = endDate
    }

    onChange(pattern)
  }, [enabled, type, interval, time, weekdays, monthDay, endDate])

  const toggleWeekday = (day: number) => {
    setWeekdays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort()
    )
  }

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="enable-recurrence"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-border bg-background text-primary"
        />
        <Label htmlFor="enable-recurrence" className="cursor-pointer font-medium">
          Recurring Task
        </Label>
      </div>

      {enabled && (
        <div className="space-y-4 pl-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="recurrence-type">Frequency</Label>
              <Select
                id="recurrence-type"
                value={type}
                onChange={(e) => setType(e.target.value as RecurrencePattern['type'])}
                options={FREQUENCY_OPTIONS}
              />
            </div>

            <div>
              <Label htmlFor="recurrence-time">Time</Label>
              <Input
                id="recurrence-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>

          {type === 'daily' && (
            <div>
              <Label htmlFor="recurrence-interval">Every (days)</Label>
              <Input
                id="recurrence-interval"
                type="number"
                min={1}
                value={interval}
                onChange={(e) => setInterval(parseInt(e.target.value) || 1)}
              />
            </div>
          )}

          {type === 'weekly' && (
            <div>
              <Label>Days of week</Label>
              <div className="flex gap-2 mt-2">
                {WEEKDAYS.map(({ value: day, label }) => (
                  <Button
                    key={day}
                    type="button"
                    variant={weekdays.includes(day) ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleWeekday(day)}
                    className="flex-1"
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {type === 'monthly' && (
            <div>
              <Label htmlFor="recurrence-monthday">Day of month</Label>
              <Input
                id="recurrence-monthday"
                type="number"
                min={1}
                max={31}
                value={monthDay}
                onChange={(e) => setMonthDay(parseInt(e.target.value) || 1)}
              />
            </div>
          )}

          <div>
            <Label htmlFor="recurrence-enddate">End date (optional)</Label>
            <Input
              id="recurrence-enddate"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
