import { create } from 'zustand'
import {
  ArtifactType,
  type Artifact,
  type ArtifactApi,
  type ArtifactFileEntry,
  type ArtifactUIState
} from '@shared/artifacts'
import type { TranscriptPartRecord } from '@/types/electron'
import { onArtifactUpdated } from '@/lib/ipc-client'

export enum PinnedArtifactTabId {
  DETAILS = 'details',
  CHANGES = 'changes',
  OUTPUT = 'output'
}

const STORAGE_KEY = '20x:task:artifacts'
const DEFAULT_UI: ArtifactUIState = { open: false, activeTabId: null, railExpanded: false }

interface PersistedState {
  artifactsByTask?: Record<string, Artifact[]>
  uiByTask?: Record<string, ArtifactUIState>
}

interface TurnSelectionState {
  active: boolean
  userSelectedTab: boolean
}

interface ArtifactState {
  artifactsByTask: Record<string, Artifact[]>
  uiByTask: Record<string, ArtifactUIState>
  turnsByTask: Record<string, TurnSelectionState>
  hydratedTasks: Record<string, boolean>
  getArtifacts: (taskId: string) => Artifact[]
  getUI: (taskId: string) => ArtifactUIState
  upsertArtifact: (artifact: Omit<Artifact, 'id' | 'reloadTrigger'> & { id?: string }, follow?: boolean) => Artifact
  removeArtifact: (taskId: string, artifactId: string) => void
  setOpen: (taskId: string, open: boolean) => void
  setRailExpanded: (taskId: string, expanded: boolean) => void
  selectTab: (taskId: string, tabId: string | null, manual?: boolean) => void
  openArtifact: (taskId: string, artifactId: string, manual?: boolean) => void
  beginTurn: (taskId: string) => void
  endTurn: (taskId: string) => void
  projectTranscriptParts: (taskId: string, parts: TranscriptPartRecord[]) => Artifact[]
  hydrate: (taskId: string, artifactApi: ArtifactApi) => Promise<void>
  resetTask: (taskId: string) => void
}

function readPersistedState(): PersistedState {
  try {
    if (typeof localStorage === 'undefined') return {}
    const value = localStorage.getItem(STORAGE_KEY)
    return value ? JSON.parse(value) as PersistedState : {}
  } catch {
    return {}
  }
}

function persist(state: Pick<ArtifactState, 'artifactsByTask' | 'uiByTask'>): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        artifactsByTask: state.artifactsByTask,
        uiByTask: state.uiByTask
      }))
    }
  } catch {
    // Preferences are best-effort (private windows and quota errors are safe).
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
}

function normalizeToolPath(taskId: string, path: string): string {
  const normalized = normalizePath(path)
  const workspaceMarker = `/workspaces/${taskId}/`
  const workspaceIndex = normalized.lastIndexOf(workspaceMarker)
  return workspaceIndex >= 0
    ? normalized.slice(workspaceIndex + workspaceMarker.length)
    : normalized
}

function identity(taskId: string, type: ArtifactType, target: string): string {
  return `${taskId}:${type}:${encodeURIComponent(target)}`
}

function titleFromTarget(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.split('/').pop() || target
}

function inferType(path: string): ArtifactType {
  const clean = path.split(/[?#]/, 1)[0].toLowerCase()
  if (clean.endsWith('.md') || clean.endsWith('.mdx')) return ArtifactType.MARKDOWN
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(clean)) return ArtifactType.IMAGE
  if (/\.(html?|xhtml)$/.test(clean)) return ArtifactType.HTML
  return ArtifactType.FILE
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function firstString(object: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!object) return undefined
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function findUrl(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.match(/https?:\/\/[^\s)\]>'"]+/)?.[0]
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findUrl(item)
      if (url) return url
    }
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const url = findUrl(item)
      if (url) return url
    }
  }
  return undefined
}

function isSuccessful(status: unknown): boolean {
  if (typeof status !== 'string') return false
  return ['success', 'succeeded', 'complete', 'completed'].includes(status.toLowerCase())
}

export interface ArtifactMessageLike {
  partType?: string
  content?: unknown
  tool?: unknown
  createdAt?: number
  updatedAt?: number
  timestamp?: Date | number
}

export function artifactsFromMessage(taskId: string, message: ArtifactMessageLike): Array<Omit<Artifact, 'id' | 'reloadTrigger'>> {
  if (message.partType !== 'tool' || !message.tool || typeof message.tool !== 'object') return []
  const tool = message.tool as Record<string, unknown>
  if (!isSuccessful(tool.status)) return []

  const name = typeof tool.name === 'string' ? tool.name.toLowerCase() : ''
  const input = parseObject(tool.input)
  const output = parseObject(tool.output)
  const timestamp = message.timestamp instanceof Date ? message.timestamp.getTime() : message.timestamp
  const updatedAt = message.updatedAt || message.createdAt || timestamp || Date.now()
  const artifacts: Array<Omit<Artifact, 'id' | 'reloadTrigger'>> = []

  if (['write', 'edit', 'multiedit', 'notebookedit'].includes(name)) {
    const rawPath = firstString(input, ['file_path', 'path', 'filename', 'notebook_path'])
      || firstString(output, ['file_path', 'path', 'filename', 'notebook_path'])
    if (rawPath) {
      const path = normalizeToolPath(taskId, rawPath)
      artifacts.push({ taskId, type: inferType(path), title: titleFromTarget(path), path, updatedAt })
    }
  }

  if (name.includes('screenshot')) {
    const rawPath = firstString(output, ['file_path', 'path', 'filename'])
      || firstString(input, ['file_path', 'path', 'filename'])
    const url = findUrl(tool.output)
    if (rawPath) {
      const path = normalizeToolPath(taskId, rawPath)
      artifacts.push({ taskId, type: ArtifactType.IMAGE, title: titleFromTarget(path), path, updatedAt })
    } else if (url) {
      artifacts.push({ taskId, type: ArtifactType.IMAGE, title: titleFromTarget(url), url, updatedAt })
    }
  }

  const prUrl = findUrl(tool.output) || findUrl(message.content)
  if (prUrl && /\/(pull|merge_requests)\/\d+(?:\b|\/)/.test(prUrl)) {
    artifacts.push({ taskId, type: ArtifactType.PR, title: `Pull request ${titleFromTarget(prUrl)}`, url: prUrl, updatedAt })
  }

  return artifacts
}

export function artifactsFromTranscriptPart(taskId: string, part: TranscriptPartRecord): Array<Omit<Artifact, 'id' | 'reloadTrigger'>> {
  return artifactsFromMessage(taskId, part)
}

function fromFileEntry(taskId: string, entry: ArtifactFileEntry): Omit<Artifact, 'id' | 'reloadTrigger'> {
  const path = normalizePath(entry.path)
  return {
    taskId,
    type: entry.type,
    title: entry.title || titleFromTarget(path),
    path,
    updatedAt: entry.updatedAt
  }
}

const persisted = readPersistedState()

export const useArtifactStore = create<ArtifactState>((set, get) => ({
  artifactsByTask: persisted.artifactsByTask || {},
  uiByTask: persisted.uiByTask || {},
  turnsByTask: {},
  hydratedTasks: {},

  getArtifacts: (taskId) => get().artifactsByTask[taskId] || [],
  getUI: (taskId) => get().uiByTask[taskId] || DEFAULT_UI,

  upsertArtifact: (candidate, follow = false) => {
    const target = candidate.path || candidate.url
    if (!target) throw new Error('Artifact requires a path or URL')
    const id = candidate.id || identity(candidate.taskId, candidate.type, target)
    let result!: Artifact
    set((state) => {
      const current = state.artifactsByTask[candidate.taskId] || []
      const index = current.findIndex((artifact) => artifact.id === id)
      const previous = index >= 0 ? current[index] : undefined
      const turn = state.turnsByTask[candidate.taskId]
      const shouldFollow = follow && turn?.active && !turn.userSelectedTab
      const currentUI = state.getUI(candidate.taskId)

      if (
        previous
        && previous.taskId === candidate.taskId
        && previous.type === candidate.type
        && previous.title === candidate.title
        && previous.path === candidate.path
        && previous.url === candidate.url
        && previous.updatedAt === candidate.updatedAt
        && (!shouldFollow || (currentUI.open && currentUI.activeTabId === id))
      ) {
        result = previous
        return state
      }

      result = {
        ...previous,
        ...candidate,
        id,
        reloadTrigger: previous
          ? previous.reloadTrigger + (candidate.updatedAt > previous.updatedAt ? 1 : 0)
          : 0
      }
      const next = [...current]
      if (index >= 0) next[index] = result
      else next.push(result)

      const nextState = {
        artifactsByTask: { ...state.artifactsByTask, [candidate.taskId]: next },
        uiByTask: shouldFollow
          ? { ...state.uiByTask, [candidate.taskId]: { ...state.getUI(candidate.taskId), open: true, activeTabId: id } }
          : state.uiByTask
      }
      persist(nextState)
      return nextState
    })
    return result
  },

  removeArtifact: (taskId, artifactId) => set((state) => {
    const nextArtifacts = (state.artifactsByTask[taskId] || []).filter((artifact) => artifact.id !== artifactId)
    const currentUI = state.getUI(taskId)
    const nextUI = currentUI.activeTabId === artifactId
      ? { ...currentUI, activeTabId: null }
      : currentUI
    const nextState = {
      artifactsByTask: { ...state.artifactsByTask, [taskId]: nextArtifacts },
      uiByTask: { ...state.uiByTask, [taskId]: nextUI }
    }
    persist(nextState)
    return nextState
  }),

  setOpen: (taskId, open) => set((state) => {
    const next = { ...state.uiByTask, [taskId]: { ...state.getUI(taskId), open } }
    persist({ artifactsByTask: state.artifactsByTask, uiByTask: next })
    return { uiByTask: next }
  }),

  setRailExpanded: (taskId, railExpanded) => set((state) => {
    const next = { ...state.uiByTask, [taskId]: { ...state.getUI(taskId), railExpanded } }
    persist({ artifactsByTask: state.artifactsByTask, uiByTask: next })
    return { uiByTask: next }
  }),

  selectTab: (taskId, activeTabId, manual = true) => set((state) => {
    const nextUI = { ...state.uiByTask, [taskId]: { ...state.getUI(taskId), activeTabId, open: activeTabId !== null } }
    const turn = state.turnsByTask[taskId]
    const nextTurns = manual && turn?.active
      ? { ...state.turnsByTask, [taskId]: { ...turn, userSelectedTab: true } }
      : state.turnsByTask
    persist({ artifactsByTask: state.artifactsByTask, uiByTask: nextUI })
    return { uiByTask: nextUI, turnsByTask: nextTurns }
  }),

  openArtifact: (taskId, artifactId, manual = true) => {
    get().selectTab(taskId, artifactId, manual)
  },

  beginTurn: (taskId) => set((state) => ({
    turnsByTask: { ...state.turnsByTask, [taskId]: { active: true, userSelectedTab: false } }
  })),

  endTurn: (taskId) => set((state) => ({
    turnsByTask: { ...state.turnsByTask, [taskId]: { active: false, userSelectedTab: false } }
  })),

  projectTranscriptParts: (taskId, parts) => {
    const projected = parts.flatMap((part) => artifactsFromTranscriptPart(taskId, part))
    return projected.map((artifact) => get().upsertArtifact(artifact, true))
  },

  hydrate: async (taskId, artifactApi) => {
    // Claim hydration before awaiting IPC. React StrictMode mounts effects twice
    // in development; without this guard both scans race and replay every file.
    let shouldHydrate = false
    set((state) => {
      if (state.hydratedTasks[taskId]) return state
      shouldHydrate = true
      return { hydratedTasks: { ...state.hydratedTasks, [taskId]: true } }
    })
    if (!shouldHydrate) return

    let entries: ArtifactFileEntry[]
    try {
      entries = await artifactApi.scan(taskId)
    } catch (error) {
      set((state) => {
        const hydratedTasks = { ...state.hydratedTasks }
        delete hydratedTasks[taskId]
        return { hydratedTasks }
      })
      throw error
    }

    // Merge the full scan atomically. Coding workspaces commonly contain
    // hundreds of previewable source files; one Zustand update per file caused
    // React to queue hundreds of full transcript renders and exhaust memory.
    set((state) => {
      const current = state.artifactsByTask[taskId] || []
      const byId = new Map(current.map((artifact) => [artifact.id, artifact]))
      let changed = false

      for (const entry of entries) {
        const candidate = fromFileEntry(taskId, entry)
        const target = candidate.path || candidate.url
        if (!target) continue
        const id = identity(taskId, candidate.type, target)
        const previous = byId.get(id)
        if (
          previous
          && previous.type === candidate.type
          && previous.title === candidate.title
          && previous.path === candidate.path
          && previous.url === candidate.url
          && previous.updatedAt === candidate.updatedAt
        ) continue

        byId.set(id, {
          ...previous,
          ...candidate,
          id,
          reloadTrigger: previous
            ? previous.reloadTrigger + (candidate.updatedAt > previous.updatedAt ? 1 : 0)
            : 0
        })
        changed = true
      }

      if (!changed) return state
      const nextState = {
        artifactsByTask: { ...state.artifactsByTask, [taskId]: [...byId.values()] },
        uiByTask: state.uiByTask
      }
      persist(nextState)
      return nextState
    })
  },

  resetTask: (taskId) => set((state) => {
    const artifactsByTask = { ...state.artifactsByTask }
    const uiByTask = { ...state.uiByTask }
    const turnsByTask = { ...state.turnsByTask }
    const hydratedTasks = { ...state.hydratedTasks }
    delete artifactsByTask[taskId]
    delete uiByTask[taskId]
    delete turnsByTask[taskId]
    delete hydratedTasks[taskId]
    persist({ artifactsByTask, uiByTask })
    return { artifactsByTask, uiByTask, turnsByTask, hydratedTasks }
  })
}))

if (typeof window !== 'undefined' && typeof window.electronAPI?.onArtifactUpdated === 'function') {
  onArtifactUpdated(({ artifact }) => {
    useArtifactStore.getState().upsertArtifact(artifact, true)
  })
}
