import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { BrowserRecordingManifest, BrowserRecordingSnapshot, BrowserRecordingStep } from '../shared/browser-recording'

const ID = /^[a-zA-Z0-9_-]{1,100}$/
export function recordingUrl(value: string): string {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : '[non-http page]' } catch { return '[unknown page]' }
}

/** Durable, task-scoped browser records. Page capture removes secret fields before transport. */
export class BrowserRecordingService {
  private latest = new Map<string, BrowserRecordingManifest>()
  private active = new Map<string, BrowserRecordingManifest>()
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(root)) {
      if (!ID.test(name)) continue
      try {
        const manifest = this.load(name)
        const previous = this.latest.get(manifest.panelId)
        if (!previous || previous.startedAt < manifest.startedAt) this.latest.set(manifest.panelId, manifest)
        if (manifest.status === 'recording') {
          const rows = this.readRows(name)
          manifest.stepCount = rows.length
          manifest.snapshotCount = rows.filter(row => !!row.snapshotId).length
          manifest.status = 'interrupted'
          manifest.stoppedAt = new Date().toISOString()
          manifest.gaps.push('Application stopped before recording was saved.')
          this.save(manifest)
        }
      } catch { /* Ignore unrelated or incomplete directories. */ }
    }
  }
  private dir(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid recording ID')
    return join(this.root, id)
  }
  private load(id: string): BrowserRecordingManifest {
    return JSON.parse(readFileSync(join(this.dir(id), 'manifest.json'), 'utf8'))
  }
  private save(manifest: BrowserRecordingManifest): void {
    const dir = this.dir(manifest.id)
    writeFileSync(join(dir, 'manifest.tmp'), JSON.stringify(manifest), { mode: 0o600 })
    renameSync(join(dir, 'manifest.tmp'), join(dir, 'manifest.json'))
  }
  last(panelId: string): BrowserRecordingManifest | null { return this.latest.get(panelId) ?? null }
  status(panelId: string): BrowserRecordingManifest | null { return this.active.get(panelId) ?? null }
  start(panelId: string, taskIds: string[], title?: string): BrowserRecordingManifest {
    if (this.active.has(panelId)) throw new Error('This browser is already recording')
    const manifest: BrowserRecordingManifest = {
      version: 1, id: randomUUID(), panelId, title: (title || 'Browser recording').slice(0, 160),
      taskIds: [...new Set(taskIds)], startedAt: new Date().toISOString(), status: 'recording', stepCount: 0, snapshotCount: 0,
      gaps: ['Only the main document is captured. Frames, native dialogs, popups, closed shadow roots and events before document capture starts are not captured.', 'Sensitive input values, page titles and URL query strings are omitted. Secret detection uses field metadata; unnamed sensitive fields may not be detected. Snapshots contain visible element structure, labels, bounded page text and ordinary values; no screenshots. Human snapshots use the page state before its event handler runs. Agent interaction snapshots follow the command; navigation intent snapshots precede navigation. The final snapshot shows the page state when Stop is selected.']
    }
    mkdirSync(this.dir(manifest.id), { mode: 0o700 })
    this.save(manifest)
    this.active.set(panelId, manifest)
    this.latest.set(panelId, manifest)
    return manifest
  }
  append(panelId: string, step: Omit<BrowserRecordingStep, 'sequence' | 'at' | 'snapshotId'>, snapshot?: Omit<BrowserRecordingSnapshot, 'id'>): void {
    const m = this.active.get(panelId)
    if (!m) return
    if (m.stepCount >= 10000) { this.gap(panelId, 'Capture limit reached: 10000 steps.'); this.stop(panelId, m.taskIds, true); return }
    const row: BrowserRecordingStep = { ...step, url: step.url ? recordingUrl(step.url) : undefined, sequence: m.stepCount + 1, at: new Date().toISOString() }
    if (snapshot) {
      const id = `s${m.snapshotCount + 1}`
      writeFileSync(join(this.dir(m.id), `${id}.json`), JSON.stringify({ ...snapshot, url: recordingUrl(snapshot.url), id }), { mode: 0o600 })
      row.snapshotId = id
      m.snapshotCount++
    }
    appendFileSync(join(this.dir(m.id), 'steps.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 })
    m.stepCount++
    this.save(m)
  }
  gap(panelId: string, message: string): void {
    const m = this.active.get(panelId)
    if (m && !m.gaps.includes(message)) { m.gaps.push(message); this.save(m) }
  }
  stop(panelId: string, taskIds: string[], interrupted = false): BrowserRecordingManifest {
    const m = this.active.get(panelId)
    if (!m) throw new Error('This browser is not recording')
    m.taskIds = [...new Set(taskIds)]
    m.status = interrupted ? 'interrupted' : 'saved'
    m.stoppedAt = new Date().toISOString()
    this.save(m)
    this.active.delete(panelId)
    return m
  }
  interrupt(panelId: string, taskIds: string[], message: string): BrowserRecordingManifest | null {
    const m = this.active.get(panelId)
    if (!m) return null
    if (!m.gaps.includes(message)) m.gaps.push(message)
    m.taskIds = [...new Set(taskIds)]
    m.status = 'interrupted'
    m.stoppedAt = new Date().toISOString()
    this.active.delete(panelId)
    try { this.save(m) } catch { /* Keep the failure visible in memory when storage is unavailable. */ }
    return m
  }
  list(taskId: string): BrowserRecordingManifest[] {
    return readdirSync(this.root).filter(id => ID.test(id)).flatMap(id => {
      try { const m = this.load(id); return m.taskIds.includes(taskId) ? [m] : [] } catch { return [] }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }
  get(taskId: string, id: string): BrowserRecordingManifest {
    const m = this.load(id)
    if (!m.taskIds.includes(taskId)) throw new Error('Recording is not linked to this task')
    return m
  }
  private readRows(id: string): BrowserRecordingStep[] {
    const file = join(this.dir(id), 'steps.jsonl')
    const rows: BrowserRecordingStep[] = []
    if (!existsSync(file)) return rows
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (row.sequence !== rows.length + 1 || typeof row.action !== 'string') break
        rows.push(row)
      } catch { break }
    }
    return rows
  }
  steps(taskId: string, id: string, offset = 0, limit = 50): { steps: BrowserRecordingStep[]; total: number; nextOffset: number | null } {
    this.get(taskId, id)
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Use a non-negative offset and limit from 1 to 100')
    const rows = this.readRows(id)
    return { steps: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null }
  }
  snapshot(taskId: string, id: string, snapshotId: string): BrowserRecordingSnapshot {
    this.get(taskId, id)
    if (!/^s[1-9][0-9]{0,5}$/.test(snapshotId)) throw new Error('Invalid snapshot ID')
    return JSON.parse(readFileSync(join(this.dir(id), `${snapshotId}.json`), 'utf8'))
  }
}
