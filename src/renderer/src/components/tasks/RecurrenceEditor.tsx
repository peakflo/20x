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

type FrequencyType = 'daily' | 'weekly' | 'monthly'

/** Parse a cron string back into visual controls state */
function parseCronToState(cron: string): {
  type: FrequencyType
  interval: number
  time: string
  weekdays: number[]
  monthDay: number
} {
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) {
    return { type: 'daily', interval: 1, time: '09:00', weekdays: [1, 2, 3, 4, 5], monthDay: 1 }
  }

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`

  // Monthly: specific day-of-month, any day-of-week
  if (dayOfMonth !== '*' && !dayOfMonth.startsWith('*/') && dayOfWeek === '*') {
    return { type: 'monthly', interval: 1, time, weekdays: [1, 2, 3, 4, 5], monthDay: parseInt(dayOfMonth) || 1 }
  }

  // Weekly: specific day-of-week
  if (dayOfWeek !== '*') {
    const weekdays = dayOfWeek.split(',').flatMap(part => {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number)
        const days: number[] = []
        for (let i = start; i <= end; i++) days.push(i)
        return days
      }
      return [parseInt(part)]
    }).filter(n => !isNaN(n))
    return { type: 'weekly', interval: 1, time, weekdays, monthDay: 1 }
  }

  // Daily
  let interval = 1
  if (dayOfMonth.startsWith('*/')) {
    interval = parseInt(dayOfMonth.slice(2)) || 1
  }
  return { type: 'daily', interval, time, weekdays: [1, 2, 3, 4, 5], monthDay: 1 }
}

/** Build a cron expression from visual controls */
function buildCronExpression(
  type: FrequencyType,
  interval: number,
  time: string,
  weekdays: number[],
  monthDay: number
): string {
  const [hour, minute] = time.split(':').map(s => parseInt(s) || 0)

  switch (type) {
    case 'daily':
      return interval === 1
        ? `${minute} ${hour} * * *`
        : `${minute} ${hour} */${interval} * *`
    case 'weekly':
      return `${minute} ${hour} * * ${weekdays.sort((a, b) => a - b).join(',')}`
    case 'monthly':
      return `${minute} ${hour} ${monthDay} * *`
  }
}

export function RecurrenceEditor({ value, onChange }: RecurrenceEditorProps) {
  const [enabled, setEnabled] = useState(!!value)
  const [advancedMode, setAdvancedMode] = useState(false)
  const [rawCron, setRawCron] = useState(typeof value === 'string' ? value : '')

  // Parse initial state from either cron string or legacy object
  const initialState = typeof value === 'string'
    ? parseCronToState(value)
    : {
        type: (value?.type || 'daily') as FrequencyType,
        interval: value?.interval || 1,
        time: value?.time || '09:00',
        weekdays: value?.weekdays || [1, 2, 3, 4, 5],
        monthDay: value?.monthDay || 1
      }

  const [type, setType] = useState<FrequencyType>(initialState.type)
  const [interval, setInterval] = useState(initialState.interval)
  const [time, setTime] = useState(initialState.time)
  const [weekdays, setWeekdays] = useState<number[]>(initialState.weekdays)
  const [monthDay, setMonthDay] = useState(initialState.monthDay)

  useEffect(() => {
    if (!enabled) {
      onChange(null)
      return
    }

    if (advancedMode) {
      if (rawCron.trim()) {
        onChange(rawCron.trim())
      }
      return
    }

    const cron = buildCronExpression(type, interval, time, weekdays, monthDay)
    setRawCron(cron)
    onChange(cron)
  }, [enabled, type, interval, time, weekdays, monthDay, advancedMode, rawCron])

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
        {enabled && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAdvancedMode(!advancedMode)}
            className="ml-auto text-xs text-muted-foreground"
          >
            {advancedMode ? 'Visual' : 'Cron'}
          </Button>
        )}
      </div>

      {enabled && advancedMode && (
        <div className="pl-6">
          <Label htmlFor="raw-cron">Cron expression</Label>
          <Input
            id="raw-cron"
            placeholder="0 9 * * 1-5"
            value={rawCron}
            onChange={(e) => setRawCron(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            minute hour day-of-month month day-of-week
          </p>
        </div>
      )}

      {enabled && !advancedMode && (
        <div className="space-y-4 pl-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="recurrence-type">Frequency</Label>
              <Select
                id="recurrence-type"
                value={type}
                onChange={(e) => setType(e.target.value as FrequencyType)}
                options={FREQUENCY_OPTIONS}
              />
            </div>

            <div>
              <Label htmlFor="recurrence-time">Time (UTC)</Label>
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

          <p className="text-xs text-muted-foreground">
            Cron: <code className="bg-accent px-1 rounded">{buildCronExpression(type, interval, time, weekdays, monthDay)}</code>
          </p>
        </div>
      )}
    </div>
  )
}
