import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BrowserRecordingService, recordingUrl } from './browser-recording'
import { buildRecordingInstallScript, buildRecordingSnapshotScript, RECORDING_REMOVE_SCRIPT } from './browser-recording-scripts'

const roots: string[] = []
function service(): { root: string; store: BrowserRecordingService } {
  const root = mkdtempSync(join(tmpdir(), '20x-recordings-test-'))
  roots.push(root)
  return { root, store: new BrowserRecordingService(root) }
}
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

describe('durable browser recordings', () => {
  it('keeps ordered pages and snapshots after restart, with stop-time task access', () => {
    const { root, store } = service()
    const m = store.start('panel', ['old-task'])
    store.append('panel', { source: 'human', action: 'click', url: 'https://example.com/form?token=secret#hash' }, { url: 'https://example.com/form?token=secret', elements: [{ tag: 'button', role: '', name: 'Save' }], truncated: false })
    store.append('panel', { source: 'agent', action: 'click', outcome: 'error' })
    store.stop('panel', ['new-task', 'new-task'])
    const reopened = new BrowserRecordingService(root)
    expect(reopened.list('old-task')).toEqual([])
    expect(reopened.get('new-task', m.id).taskIds).toEqual(['new-task'])
    const first = reopened.steps('new-task', m.id, 0, 1)
    expect(first.total).toBe(2)
    expect(first.nextOffset).toBe(1)
    expect(first.steps[0].url).toBe('https://example.com/form')
    expect(reopened.snapshot('new-task', m.id, first.steps[0].snapshotId!).elements[0].name).toBe('Save')
    expect(reopened.steps('new-task', m.id, 1, 1).steps[0].outcome).toBe('error')
    expect(reopened.steps('new-task', m.id, 1, 1).nextOffset).toBeNull()
  })
  it('rejects task leakage, invalid IDs and unbounded page sizes', () => {
    const { store } = service()
    const m = store.start('panel', ['task'])
    expect(() => store.get('other', m.id)).toThrow('not linked')
    expect(() => store.get('task', '../manifest')).toThrow('Invalid recording ID')
    expect(() => store.snapshot('task', m.id, '../../secret')).toThrow('Invalid snapshot ID')
    expect(() => store.steps('task', m.id, 0, 101)).toThrow()
    expect(() => store.steps('task', m.id, -1, 1)).toThrow()
  })
  it('recovers the valid prefix and marks an unfinished session interrupted', () => {
    const { root, store } = service()
    const m = store.start('panel', ['task'])
    store.append('panel', { source: 'human', action: 'click' })
    appendFileSync(join(root, m.id, 'steps.jsonl'), '{broken\n' + JSON.stringify({ sequence: 2, action: 'must not recover' }) + '\n')
    const recovered = new BrowserRecordingService(root)
    expect(recovered.get('task', m.id)).toMatchObject({ status: 'interrupted', stepCount: 1 })
    expect(recovered.steps('task', m.id).total).toBe(1)
    expect(recovered.status('panel')).toBeNull()
  })
  it('prevents duplicate starts and strips URL credentials/query/fragment', () => {
    const { store } = service()
    store.start('panel', ['task'])
    expect(() => store.start('panel', ['task'])).toThrow('already recording')
    expect(recordingUrl('https://user:pass@example.com/path?secret=token#secret')).toBe('https://example.com/path')
    expect(recordingUrl('file:///private/file')).toBe('[non-http page]')
  })
  it('writes metadata without query secrets', () => {
    const { root, store } = service()
    const m = store.start('panel', ['task'])
    store.append('panel', { source: 'human', action: 'click', url: 'https://example.com/?password=do-not-save' })
    expect(readFileSync(join(root, m.id, 'steps.jsonl'), 'utf8')).not.toContain('do-not-save')
  })
  it('interrupts the recording when the step limit is reached', () => {
    const { store } = service()
    const m = store.start('panel', ['task'])
    m.stepCount = 10000
    store.append('panel', { source: 'human', action: 'click' })
    expect(store.status('panel')).toBeNull()
    expect(store.last('panel')).toMatchObject({ status: 'interrupted', stepCount: 10000 })
    expect(store.last('panel')?.gaps).toContain('Capture limit reached: 10000 steps.')
  })
})

describe('page recording scripts', () => {
  it('builds valid scripts without touching agent refs or exposing page bridge', () => {
    expect(() => new Function(buildRecordingInstallScript('nonce'))).not.toThrow()
    expect(() => new Function(buildRecordingSnapshotScript())).not.toThrow()
    expect(buildRecordingSnapshotScript()).not.toContain('setAttribute')
    expect(buildRecordingInstallScript('nonce')).toContain('event.isTrusted')
    expect(buildRecordingInstallScript('nonce')).toContain("window.addEventListener('pagehide', flush")
    expect(buildRecordingInstallScript('nonce')).toContain('recording-flush-complete')
    expect(buildRecordingInstallScript('nonce')).toContain("target.index ? '#' + target.index")
    expect(buildRecordingSnapshotScript()).toContain('locator:')
    expect(RECORDING_REMOVE_SCRIPT).toContain('return true')
  })
})
