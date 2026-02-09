import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTaskSourceStore } from './task-source-store'

const mockElectronAPI = window.electronAPI

beforeEach(() => {
  useTaskSourceStore.setState({
    sources: [],
    isLoading: false,
    error: null,
    syncingIds: new Set(),
    lastSyncResults: new Map()
  })
  vi.clearAllMocks()
})

describe('useTaskSourceStore', () => {
  describe('fetchSources', () => {
    it('fetches and sets sources', async () => {
      const sources = [{ id: 'ts1', name: 'Source 1' }]
      ;(mockElectronAPI.taskSources.getAll as any).mockResolvedValue(sources)

      await useTaskSourceStore.getState().fetchSources()

      expect(useTaskSourceStore.getState().sources).toEqual(sources)
      expect(useTaskSourceStore.getState().isLoading).toBe(false)
    })
  })

  describe('createSource', () => {
    it('appends source to list', async () => {
      const newSource = { id: 'ts1', name: 'New Source' }
      ;(mockElectronAPI.taskSources.create as any).mockResolvedValue(newSource)

      const result = await useTaskSourceStore.getState().createSource({
        mcp_server_id: 'm1',
        name: 'New Source',
        plugin_id: 'peakflo'
      } as any)

      expect(result).toEqual(newSource)
      expect(useTaskSourceStore.getState().sources).toHaveLength(1)
    })
  })

  describe('updateSource', () => {
    it('updates source in list', async () => {
      useTaskSourceStore.setState({ sources: [{ id: 'ts1', name: 'Old' }] as any })
      const updated = { id: 'ts1', name: 'Updated' }
      ;(mockElectronAPI.taskSources.update as any).mockResolvedValue(updated)

      await useTaskSourceStore.getState().updateSource('ts1', { name: 'Updated' } as any)

      expect(useTaskSourceStore.getState().sources[0].name).toBe('Updated')
    })
  })

  describe('deleteSource', () => {
    it('removes source from list', async () => {
      useTaskSourceStore.setState({ sources: [{ id: 'ts1' }, { id: 'ts2' }] as any })
      ;(mockElectronAPI.taskSources.delete as any).mockResolvedValue(true)

      const result = await useTaskSourceStore.getState().deleteSource('ts1')

      expect(result).toBe(true)
      expect(useTaskSourceStore.getState().sources).toHaveLength(1)
    })
  })

  describe('syncSource', () => {
    it('adds to syncingIds during sync and removes after', async () => {
      const syncResult = { source_id: 'ts1', imported: 3, updated: 1, errors: [] }
      ;(mockElectronAPI.taskSources.sync as any).mockResolvedValue(syncResult)

      useTaskSourceStore.setState({
        sources: [{ id: 'ts1', last_synced_at: null }] as any
      })

      const result = await useTaskSourceStore.getState().syncSource('ts1')

      expect(result).toEqual(syncResult)
      expect(useTaskSourceStore.getState().syncingIds.has('ts1')).toBe(false)
      expect(useTaskSourceStore.getState().lastSyncResults.get('ts1')).toEqual(syncResult)
      expect(useTaskSourceStore.getState().sources[0].last_synced_at).toBeTruthy()
    })

    it('clears syncingIds on error', async () => {
      ;(mockElectronAPI.taskSources.sync as any).mockRejectedValue(new Error('fail'))

      const result = await useTaskSourceStore.getState().syncSource('ts1')

      expect(result).toBeNull()
      expect(useTaskSourceStore.getState().syncingIds.has('ts1')).toBe(false)
    })
  })

  describe('syncAllEnabled', () => {
    it('syncs all enabled sources', async () => {
      useTaskSourceStore.setState({
        sources: [
          { id: 'ts1', enabled: true },
          { id: 'ts2', enabled: false },
          { id: 'ts3', enabled: true }
        ] as any
      })
      ;(mockElectronAPI.taskSources.sync as any).mockResolvedValue({
        source_id: '', imported: 0, updated: 0, errors: []
      })

      await useTaskSourceStore.getState().syncAllEnabled()

      expect(mockElectronAPI.taskSources.sync).toHaveBeenCalledTimes(2)
    })
  })

  describe('executeAction', () => {
    it('calls plugin executeAction', async () => {
      ;(mockElectronAPI.plugins.executeAction as any).mockResolvedValue({
        success: true,
        taskUpdate: { status: 'completed' }
      })

      const result = await useTaskSourceStore.getState().executeAction(
        'approve', 'task-1', 'src-1'
      )

      expect(result.success).toBe(true)
      expect(mockElectronAPI.plugins.executeAction).toHaveBeenCalledWith(
        'approve', 'task-1', 'src-1', undefined
      )
    })

    it('returns error result on failure', async () => {
      ;(mockElectronAPI.plugins.executeAction as any).mockRejectedValue(new Error('fail'))

      const result = await useTaskSourceStore.getState().executeAction(
        'approve', 'task-1', 'src-1'
      )

      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
    })
  })
})
