/**
 * Main-process cost of one Workflo (enterprise) task-cache sync.
 *
 * A remote task that is not found under this source by external id falls back
 * to matching any local task with the same external id and tenant — the case
 * of a source that was removed and added again, or a first sync on a new
 * machine profile. On a first sync EVERY remote task takes that path.
 *
 * Seed (real file-backed DB through the production `initialize()`):
 * 1,000 local tasks — 500 linked to an OLD Workflo source (with server
 * snapshots), 500 plain. The sync runs on a NEW source and receives 100
 * remote tasks: 50 re-link to old local tasks, 50 are new.
 *
 * Printed: statements executed, rows read and median ms per sync.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { PeakfloPlugin } from './peakflo-plugin'
import type { PluginContext } from './types'
import type { WorkfloTask } from '../workflo-api-client'
import { countStatements, createPerfDb, printResults, timeAsync } from '../../../test/helpers/perf-helpers'

const LOCAL = 1000
const LINKED = 500
const REMOTE = 100
const TENANT = 'tenant-1'

function remoteTask(id: string): WorkfloTask {
  return {
    id, tenantId: TENANT, workflowId: null, executionId: null, taskId: id,
    title: `Remote ${id}`, description: 'Remote description', status: 'pending',
    communicationChannel: 'app', dueDate: null, priority: 'medium',
    taskData: { fields: [], outputs: [] }, response: null,
    orgTaskSourceId: null, externalId: null, sourceType: null,
    createdAt: new Date(0).toISOString()
  } as unknown as WorkfloTask
}

const results: Record<string, string | number> = {}
afterAll(() => printResults('peakflo enterprise sync: 100 remote x 1000 local tasks', results))

describe('peakflo enterprise sync benchmark', { timeout: 120_000 }, () => {
  it('syncs 100 unmatched remote tasks against 1000 local tasks', async () => {
    const { db, raw, cleanup } = createPerfDb('20x-peakflo-perf-')
    try {
      const oldSource = db.createTaskSource({ mcp_server_id: null, name: 'Old Workflo', plugin_id: 'peakflo' })!
      const newSource = db.createTaskSource({ mcp_server_id: null, name: 'Workflo', plugin_id: 'peakflo' })!
      raw.transaction(() => {
        for (let i = 0; i < LOCAL; i++) {
          const linked = i < LINKED
          const task = db.createTask({
            title: `Local ${i}`,
            description: `Description ${i} `.repeat(10),
            ...(linked ? { source_id: oldSource.id, external_id: `wf-${i}` } : {})
          })!
          if (linked) db.setSetting(`workflo-task:${task.id}`, JSON.stringify(remoteTask(`wf-${i}`)))
        }
      })()

      // 50 remote tasks re-link to old local ones, 50 are brand new.
      const remote = Array.from({ length: REMOTE }, (_, i) => remoteTask(i < REMOTE / 2 ? `wf-${i}` : `wf-new-${i}`))
      const ctx = {
        db,
        workfloApiClient: { listTaskCache: vi.fn(async () => ({ tasks: remote, nextCursor: null })) }
      } as unknown as PluginContext
      const plugin = new PeakfloPlugin()

      const first = await countStatements(raw, () => plugin.importTasks(newSource.id, { enterprise_mode: true }, ctx))
      // The re-linked tasks keep their old source; the new ones are created.
      const after = db.getTasks()
      expect(after).toHaveLength(LOCAL + REMOTE / 2)
      expect(after.filter((t) => t.source_id === newSource.id)).toHaveLength(REMOTE / 2)

      results['first sync: statements / rows read'] = `${first.executed} / ${first.rows}`
      // Repeat syncs: the 50 re-linked tasks still miss under the new source id.
      const repeat = await countStatements(raw, () => plugin.importTasks(newSource.id, { enterprise_mode: true }, ctx))
      results['repeat sync: statements / rows read'] = `${repeat.executed} / ${repeat.rows}`
      results['repeat sync: median ms'] = (await timeAsync(7, () => plugin.importTasks(newSource.id, { enterprise_mode: true }, ctx))).toFixed(1)
      expect(db.getTasks()).toHaveLength(LOCAL + REMOTE / 2)

      // Local tasks are read once per sync, not once per unmatched remote task.
      expect(repeat.rows).toBeLessThan(5 * LOCAL)
    } finally {
      cleanup()
    }
  })
})
