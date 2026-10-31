import { describe, expect, it } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'

/**
 * Task-list loads decorate rows with Workflo server ownership through batched
 * lookups; single-task reads use per-key lookups. Both must give the same task.
 */
describe('server ownership decoration', () => {
  it('list loads match single-task reads for every ownership state', () => {
    const { db } = createTestDb()
    const peakflo = db.createTaskSource({ mcp_server_id: null, name: 'Workflo', plugin_id: 'peakflo' })!
    const other = db.createTaskSource({ mcp_server_id: null, name: 'Linear', plugin_id: 'linear' })!

    const plain = db.createTask({ title: 'plain' })!
    const linked = db.createTask({ title: 'linked', source_id: peakflo.id, external_id: 'w-1' })!
    const linkedPending = db.createTask({ title: 'linked pending', source_id: peakflo.id, external_id: 'w-2' })!
    const linkedNoSnapshot = db.createTask({ title: 'linked no snapshot', source_id: peakflo.id, external_id: 'w-3' })!
    const otherPlugin = db.createTask({ title: 'other plugin', source_id: other.id, external_id: 'l-1' })!
    const uploading = db.createTask({ title: 'uploading' })!

    const flowUse = { id: 'flow-use-1', versionId: 'version-1', version: 2, status: 'trial', judgeDecisions: [] }
    db.setSetting(`workflo-task:${linked.id}`, JSON.stringify({ cron: '0 9 * * *', executionMode: 'agent', spaceName: 'Ops', metadata: { triage: { reason: 'urgent' } }, flowUses: [flowUse] }))
    db.setSetting(`workflo-task:${linkedPending.id}`, JSON.stringify({ executionMode: 'human' }))
    db.setSetting(`workflo-update:${linkedPending.id}`, JSON.stringify({ fields: { title: 'renamed' } }))
    db.setSetting(`workflo-update:${linkedPending.id}:error`, 'conflict')
    db.setSetting(`workflo-completion:${linkedNoSnapshot.id}`, '1')
    db.setSetting(`workflo-completion:${linkedNoSnapshot.id}:error`, 'offline')
    db.setSetting(`workflo-task:${otherPlugin.id}`, JSON.stringify({ executionMode: 'agent' }))
    db.setSetting(`workflo-upload:${uploading.id}`, '1')
    db.setSetting(`workflo-upload:${uploading.id}:error`, 'quota')
    db.setSetting(`workflo-update:${uploading.id}`, JSON.stringify({ fields: { priority: 'high' } }))

    const ids = [plain, linked, linkedPending, linkedNoSnapshot, otherPlugin, uploading].map((t) => t.id)
    for (const list of [db.getOpenTasks(), db.getTasks()]) {
      expect(list).toHaveLength(ids.length)
      for (const id of ids) {
        expect(list.find((t) => t.id === id)).toEqual(db.getTask(id))
      }
    }

    // Spot-check the decorated values themselves.
    const byId = new Map(db.getOpenTasks().map((t) => [t.id, t]))
    expect(byId.get(plain.id)).not.toHaveProperty('server_managed')
    expect(byId.get(otherPlugin.id)).not.toHaveProperty('server_managed')
    expect(byId.get(linked.id)).toMatchObject({ server_managed: true, server_cron: '0 9 * * *', server_execution_mode: 'agent', server_space_name: 'Ops', server_triage_reason: 'urgent', server_flow_uses: [flowUse], server_sync_pending: false })
    expect(byId.get(linkedPending.id)).toMatchObject({ server_pending_edits: { title: 'renamed' }, server_sync_pending: true, server_sync_error: 'conflict' })
    expect(byId.get(linkedNoSnapshot.id)).toMatchObject({ server_execution_mode: 'human', server_sync_pending: true, server_sync_error: 'offline' })
    expect(byId.get(uploading.id)).toMatchObject({ server_managed: true, server_sync_pending: true, server_sync_error: 'quota', server_pending_edits: { priority: 'high' } })
  })
})
