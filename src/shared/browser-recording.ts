export interface BrowserRecordingManifest {
  version: 1
  id: string
  panelId: string
  title: string
  taskIds: string[]
  startedAt: string
  stoppedAt?: string
  status: 'recording' | 'saved' | 'interrupted'
  stepCount: number
  snapshotCount: number
  gaps: string[]
}
export interface BrowserRecordingSnapshot {
  id: string
  url: string
  elements: Array<{ tag: string; role: string; name: string; index?: number; locator?: string; inputType?: string; value?: string; checked?: boolean }>
  text?: string
  truncated: boolean
}
export interface BrowserRecordingStep {
  sequence: number
  at: string
  source: 'human' | 'agent' | 'browser'
  action: string
  target?: string
  url?: string
  outcome?: 'ok' | 'error' | 'pending'
  snapshotPhase?: 'initial' | 'before-action' | 'after-action' | 'document-ready' | 'final'
  snapshotId?: string
}
export type BrowserRecordingResult = { ok: true; recording: BrowserRecordingManifest } | { error: string }
