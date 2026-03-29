import { useState, useEffect, useRef } from 'react'
import { TaskStatus, TASK_STATUSES } from '@shared/constants'
import { useTaskStore } from '../stores/task-store'
import { cn } from '../lib/utils'
import type { Route } from '../App'

// ── Constants (mirrors desktop @/types) ─────────────────────
const TASK_TYPES = [
  { value: 'general', label: 'General' },
  { value: 'coding', label: 'Coding' },
  { value: 'manual', label: 'Manual' },
  { value: 'review', label: 'Review' },
  { value: 'approval', label: 'Approval' }
]

const TASK_PRIORITIES = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' }
]

const OUTPUT_FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'email', label: 'Email' },
  { value: 'textarea', label: 'Textarea' },
  { value: 'list', label: 'List' },
  { value: 'date', label: 'Date' },
  { value: 'file', label: 'File' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'country', label: 'Country' },
  { value: 'currency', label: 'Currency' }
]

const FREQUENCY_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }
]

const WEEKDAYS = [
  { value: 0, label: 'S' },
  { value: 1, label: 'M' },
  { value: 2, label: 'T' },
  { value: 3, label: 'W' },
  { value: 4, label: 'T' },
  { value: 5, label: 'F' },
  { value: 6, label: 'S' }
]

// ── Types ───────────────────────────────────────────────────
interface OutputField {
  id: string
  name: string
  type: string
  required?: boolean
  multiple?: boolean
  options?: string[]
}

type FrequencyType = 'daily' | 'weekly' | 'monthly'

// ── Cron helpers ────────────────────────────────────────────
function parseCronToState(cron: string) {
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) return { type: 'daily' as FrequencyType, interval: 1, time: '09:00', weekdays: [1,2,3,4,5], monthDay: 1 }
  const [minute, hour, dayOfMonth, , dayOfWeek] = parts
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  if (dayOfMonth !== '*' && !dayOfMonth.startsWith('*/') && dayOfWeek === '*') {
    return { type: 'monthly' as FrequencyType, interval: 1, time, weekdays: [1,2,3,4,5], monthDay: parseInt(dayOfMonth) || 1 }
  }
  if (dayOfWeek !== '*') {
    const weekdays = dayOfWeek.split(',').flatMap(part => {
      if (part.includes('-')) { const [s, e] = part.split('-').map(Number); const d: number[] = []; for (let i = s; i <= e; i++) d.push(i); return d }
      return [parseInt(part)]
    }).filter(n => !isNaN(n))
    return { type: 'weekly' as FrequencyType, interval: 1, time, weekdays, monthDay: 1 }
  }
  let interval = 1
  if (dayOfMonth.startsWith('*/')) interval = parseInt(dayOfMonth.slice(2)) || 1
  return { type: 'daily' as FrequencyType, interval, time, weekdays: [1,2,3,4,5], monthDay: 1 }
}

function buildCronExpression(type: FrequencyType, interval: number, time: string, weekdays: number[], monthDay: number): string {
  const [hour, minute] = time.split(':').map(s => parseInt(s) || 0)
  switch (type) {
    case 'daily': return interval === 1 ? `${minute} ${hour} * * *` : `${minute} ${hour} */${interval} * *`
    case 'weekly': return `${minute} ${hour} * * ${weekdays.sort((a, b) => a - b).join(',')}`
    case 'monthly': return `${minute} ${hour} ${monthDay} * *`
  }
}

// ── Component ───────────────────────────────────────────────
export function TaskFormPage({ taskId, onNavigate }: { taskId?: string; onNavigate: (route: Route) => void }) {
  const existingTask = useTaskStore((s) => taskId ? s.tasks.find((t) => t.id === taskId) : undefined)
  const createTask = useTaskStore((s) => s.createTask)
  const updateTask = useTaskStore((s) => s.updateTask)
  const isEdit = !!taskId

  // ── Core fields (always visible) ────────────────────────
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  // ── Additional fields (behind toggle) ───────────────────
  const [showMore, setShowMore] = useState(false)
  const [type, setType] = useState('general')
  const [priority, setPriority] = useState('medium')
  const [status, setStatus] = useState<string>(TaskStatus.NotStarted)
  const [dueDate, setDueDate] = useState('')
  const [labels, setLabels] = useState('')

  // ── Output fields ───────────────────────────────────────
  const [outputFields, setOutputFields] = useState<OutputField[]>([])
  const [newFieldName, setNewFieldName] = useState('')
  const [newFieldType, setNewFieldType] = useState('text')

  // ── Recurrence ──────────────────────────────────────────
  const [recurringEnabled, setRecurringEnabled] = useState(false)
  const [freqType, setFreqType] = useState<FrequencyType>('daily')
  const [freqInterval, setFreqInterval] = useState(1)
  const [freqTime, setFreqTime] = useState('09:00')
  const [freqWeekdays, setFreqWeekdays] = useState<number[]>([1, 2, 3, 4, 5])
  const [freqMonthDay, setFreqMonthDay] = useState(1)
  const [cronMode, setCronMode] = useState(false)
  const [rawCron, setRawCron] = useState('')

  // ── Submit state ────────────────────────────────────────
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // ── Populate form when editing (only once on initial load) ──
  // Track whether we've already populated the form to prevent
  // background polling / WebSocket updates from overwriting edits.
  const formPopulatedRef = useRef(false)

  useEffect(() => {
    if (!existingTask) return
    if (formPopulatedRef.current) return
    formPopulatedRef.current = true

    setTitle(existingTask.title)
    setDescription(existingTask.description)
    setType(existingTask.type)
    setPriority(existingTask.priority)
    setStatus(existingTask.status)
    setDueDate(existingTask.due_date ? existingTask.due_date.slice(0, 10) : '')
    setLabels(existingTask.labels.join(', '))
    setOutputFields((existingTask.output_fields || []) as OutputField[])

    // Recurrence
    if (existingTask.is_recurring && existingTask.recurrence_pattern) {
      setRecurringEnabled(true)
      if (typeof existingTask.recurrence_pattern === 'string') {
        const parsed = parseCronToState(existingTask.recurrence_pattern)
        setFreqType(parsed.type)
        setFreqInterval(parsed.interval)
        setFreqTime(parsed.time)
        setFreqWeekdays(parsed.weekdays)
        setFreqMonthDay(parsed.monthDay)
        setRawCron(existingTask.recurrence_pattern)
      }
    }

    // Auto-expand additional fields if any non-default values
    if (
      existingTask.type !== 'general' ||
      existingTask.priority !== 'medium' ||
      existingTask.due_date ||
      existingTask.labels.length > 0 ||
      (existingTask.output_fields as OutputField[]).length > 0 ||
      existingTask.is_recurring
    ) {
      setShowMore(true)
    }
  }, [existingTask])

  // ── Submit handler ──────────────────────────────────────
  const handleSubmit = async () => {
    if (!title.trim()) return
    setIsSubmitting(true)
    setSubmitError(null)

    const parsedLabels = labels.split(',').map((l) => l.trim()).filter(Boolean)

    // Build recurrence pattern
    let recurrencePattern: string | null = null
    if (recurringEnabled) {
      recurrencePattern = cronMode && rawCron.trim()
        ? rawCron.trim()
        : buildCronExpression(freqType, freqInterval, freqTime, freqWeekdays, freqMonthDay)
    }

    const data: Record<string, unknown> = {
      title: title.trim(),
      description,
      type,
      priority,
      status,
      due_date: dueDate ? new Date(dueDate).toISOString() : null,
      labels: parsedLabels,
      output_fields: outputFields,
      is_recurring: recurringEnabled,
      recurrence_pattern: recurrencePattern
    }

    try {
      if (isEdit && taskId) {
        const ok = await updateTask(taskId, data)
        if (!ok) throw new Error('Failed to save changes')
        onNavigate({ page: 'detail', taskId })
      } else {
        const task = await createTask(data)
        if (!task) throw new Error('Failed to create task')
        onNavigate({ page: 'detail', taskId: task.id })
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  // ── Output field helpers ────────────────────────────────
  const addOutputField = () => {
    if (!newFieldName.trim()) return
    const field: OutputField = { id: `f_${Date.now()}`, name: newFieldName.trim(), type: newFieldType }
    setOutputFields([...outputFields, field])
    setNewFieldName('')
    setNewFieldType('text')
  }

  const removeOutputField = (id: string) => setOutputFields(outputFields.filter((f) => f.id !== id))

  const toggleFieldFlag = (id: string, flag: 'required' | 'multiple') =>
    setOutputFields(outputFields.map((f) => f.id === id ? { ...f, [flag]: !f[flag] } : f))

  const toggleWeekday = (day: number) =>
    setFreqWeekdays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort())

  // ── Not found (edit mode) ───────────────────────────────
  if (isEdit && !existingTask) {
    return (
      <div className="flex flex-col h-full">
        <Header onBack={() => onNavigate({ page: 'list' })} title="Not found" />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Task not found</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <Header
        onBack={() => isEdit && taskId ? onNavigate({ page: 'detail', taskId }) : onNavigate({ page: 'list' })}
        title={isEdit ? 'Edit Task' : 'New Task'}
      />

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          {/* ── Title ──────────────────────────────────────── */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              autoFocus
              className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring/30"
            />
          </div>

          {/* ── Description ────────────────────────────────── */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add details, context, or notes..."
              rows={3}
              className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring focus:ring-1 focus:ring-ring/30 resize-y"
            />
          </div>

          {/* ── Toggle additional fields ───────────────────── */}
          <button
            type="button"
            onClick={() => setShowMore(!showMore)}
            className="flex items-center gap-2 text-xs text-muted-foreground active:opacity-60 py-1"
          >
            <svg
              className={cn('h-3 w-3 transition-transform', showMore && 'rotate-90')}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="m9 18 6-6-6-6"/>
            </svg>
            Additional fields
            {!showMore && (type !== 'general' || priority !== 'medium' || dueDate || labels || outputFields.length > 0 || recurringEnabled) && (
              <span className="text-primary text-[10px]">(has values)</span>
            )}
          </button>

          {showMore && (
            <div className="space-y-4 pl-1">
              {/* ── Type & Priority ───────────────────────── */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring"
                  >
                    {TASK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Priority</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                    className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring"
                  >
                    {TASK_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
              </div>

              {/* ── Status (edit mode only) ───────────────── */}
              {isEdit && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Status</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring"
                  >
                    {TASK_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
              )}

              {/* ── Due Date & Labels ─────────────────────── */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Due Date</label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Labels</label>
                  <input
                    type="text"
                    value={labels}
                    onChange={(e) => setLabels(e.target.value)}
                    placeholder="bug, feature..."
                    className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
                  />
                </div>
              </div>

              {/* ── Output Fields ─────────────────────────── */}
              <div className="space-y-2 rounded-md border border-border/50 p-3">
                <label className="text-xs font-medium text-muted-foreground">Output Fields</label>
                <p className="text-[11px] text-muted-foreground">Fields agents should fill when completing.</p>

                {outputFields.length > 0 && (
                  <div className="space-y-2">
                    {outputFields.map((field) => (
                      <div key={field.id} className="flex items-center gap-2 rounded border border-border/50 px-2 py-1.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className="font-medium truncate">{field.name}</span>
                            <span className="text-muted-foreground">({field.type})</span>
                            {field.required && <span className="text-red-400">req</span>}
                            {field.multiple && <span className="text-muted-foreground">multi</span>}
                          </div>
                          <div className="flex gap-3 mt-1">
                            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <input type="checkbox" checked={!!field.required} onChange={() => toggleFieldFlag(field.id, 'required')} className="h-3 w-3 rounded" />
                              Required
                            </label>
                            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <input type="checkbox" checked={!!field.multiple} onChange={() => toggleFieldFlag(field.id, 'multiple')} className="h-3 w-3 rounded" />
                              Multiple
                            </label>
                          </div>
                        </div>
                        <button onClick={() => removeOutputField(field.id)} className="shrink-0 p-1 text-muted-foreground active:opacity-60">
                          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-end gap-2">
                  <input
                    type="text"
                    value={newFieldName}
                    onChange={(e) => setNewFieldName(e.target.value)}
                    placeholder="Field name..."
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOutputField() } }}
                    className="flex-1 bg-transparent border border-input rounded-md px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
                  />
                  <select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value)}
                    className="bg-transparent border border-input rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring w-24"
                  >
                    {OUTPUT_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <button
                    onClick={addOutputField}
                    disabled={!newFieldName.trim()}
                    className="shrink-0 inline-flex items-center gap-1 border border-input rounded-md px-2 py-1.5 text-xs text-foreground active:opacity-60 disabled:opacity-30"
                  >
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14"/><path d="M12 5v14"/>
                    </svg>
                    Add
                  </button>
                </div>
              </div>

              {/* ── Recurrence ────────────────────────────── */}
              <div className="space-y-3 rounded-md border border-border/50 p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="enable-recurrence"
                    checked={recurringEnabled}
                    onChange={(e) => setRecurringEnabled(e.target.checked)}
                    className="h-4 w-4 rounded"
                  />
                  <label htmlFor="enable-recurrence" className="text-xs font-medium text-muted-foreground cursor-pointer">
                    Recurring Task
                  </label>
                  {recurringEnabled && (
                    <button
                      type="button"
                      onClick={() => setCronMode(!cronMode)}
                      className="ml-auto text-[11px] text-muted-foreground active:opacity-60"
                    >
                      {cronMode ? 'Visual' : 'Cron'}
                    </button>
                  )}
                </div>

                {recurringEnabled && cronMode && (
                  <div className="space-y-1.5">
                    <label className="text-[11px] text-muted-foreground">Cron expression</label>
                    <input
                      type="text"
                      value={rawCron}
                      onChange={(e) => setRawCron(e.target.value)}
                      placeholder="0 9 * * 1-5"
                      className="w-full bg-transparent border border-input rounded-md px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground">minute hour day-of-month month day-of-week</p>
                  </div>
                )}

                {recurringEnabled && !cronMode && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">Frequency</label>
                        <select
                          value={freqType}
                          onChange={(e) => setFreqType(e.target.value as FrequencyType)}
                          className="w-full bg-transparent border border-input rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring"
                        >
                          {FREQUENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">Time</label>
                        <input
                          type="time"
                          value={freqTime}
                          onChange={(e) => setFreqTime(e.target.value)}
                          className="w-full bg-transparent border border-input rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring"
                        />
                      </div>
                    </div>

                    {freqType === 'daily' && (
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">Every (days)</label>
                        <input
                          type="number"
                          min={1}
                          value={freqInterval}
                          onChange={(e) => setFreqInterval(parseInt(e.target.value) || 1)}
                          className="w-20 bg-transparent border border-input rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring"
                        />
                      </div>
                    )}

                    {freqType === 'weekly' && (
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">Days of week</label>
                        <div className="flex gap-1.5">
                          {WEEKDAYS.map(({ value: day, label }) => (
                            <button
                              key={day}
                              type="button"
                              onClick={() => toggleWeekday(day)}
                              className={cn(
                                'h-7 w-7 rounded-md text-[11px] font-medium transition-colors',
                                freqWeekdays.includes(day)
                                  ? 'bg-primary text-primary-foreground'
                                  : 'border border-input text-muted-foreground active:bg-accent'
                              )}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {freqType === 'monthly' && (
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">Day of month</label>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={freqMonthDay}
                          onChange={(e) => setFreqMonthDay(parseInt(e.target.value) || 1)}
                          className="w-20 bg-transparent border border-input rounded-md px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-ring"
                        />
                      </div>
                    )}

                    <p className="text-[10px] text-muted-foreground">
                      Cron: <code className="bg-accent px-1 rounded font-mono">{buildCronExpression(freqType, freqInterval, freqTime, freqWeekdays, freqMonthDay)}</code>
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Submit error ────────────────────────────────── */}
          {submitError && (
            <p className="text-xs text-red-400 px-1">{submitError}</p>
          )}
        </div>
      </div>

      {/* ── Bottom action bar ──────────────────────────────── */}
      <div className="shrink-0 border-t border-border px-4 py-3 flex gap-3">
        <button
          onClick={() => isEdit && taskId ? onNavigate({ page: 'detail', taskId }) : onNavigate({ page: 'list' })}
          className="flex-1 h-10 rounded-md border border-input text-sm font-medium text-foreground active:opacity-60 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!title.trim() || isSubmitting}
          className="flex-1 h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium active:opacity-80 transition-colors disabled:opacity-40"
        >
          {isSubmitting ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Task'}
        </button>
      </div>
    </div>
  )
}

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-2 py-3 border-b border-border">
      <button onClick={onBack} className="p-2 active:opacity-60 hover:bg-accent rounded-md transition-colors">
        <svg className="w-5 h-5 text-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <h1 className="text-sm font-semibold truncate flex-1">{title}</h1>
    </div>
  )
}
