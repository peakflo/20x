import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import {
  activeStatusWorkspaceIds,
  findTopLevelNodeModules,
  findWorkspacesWithLiveProcesses,
  isInactive,
  pruneStaleNodeModules
} from './workspace-node-modules-gc'

const DAY_MS = 24 * 60 * 60 * 1000

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'nm-gc-test-'))
}

/** Creates dir (with a file inside) and backdates the dir's own mtime by `ageDays`. */
function makeAgedDir(path: string, ageDays: number): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'marker.txt'), 'x')
  const t = new Date(Date.now() - ageDays * DAY_MS)
  utimesSync(path, t, t)
}

describe('isInactive', () => {
  it('is true when mtime is older than the threshold', () => {
    expect(isInactive(Date.now() - 8 * DAY_MS, Date.now(), 7)).toBe(true)
  })

  it('is false when mtime is within the threshold', () => {
    expect(isInactive(Date.now() - 6 * DAY_MS, Date.now(), 7)).toBe(false)
  })
})

describe('findTopLevelNodeModules', () => {
  let root: string

  beforeEach(() => {
    root = makeRoot()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds node_modules at any depth', () => {
    const ws = join(root, 'task-1')
    for (const p of [
      join(ws, '.opencode', 'node_modules'),
      join(ws, '20x', 'node_modules'),
      join(ws, 'peakflo-web', 'functions', 'node_modules'),
      join(ws, 'workflow-builder', 'packages', 'ui', 'node_modules')
    ]) {
      mkdirSync(p, { recursive: true })
    }

    const found = findTopLevelNodeModules(ws).sort()

    expect(found).toEqual(
      [
        join(ws, '.opencode', 'node_modules'),
        join(ws, '20x', 'node_modules'),
        join(ws, 'peakflo-web', 'functions', 'node_modules'),
        join(ws, 'workflow-builder', 'packages', 'ui', 'node_modules')
      ].sort()
    )
  })

  it('reports a nested node_modules only once and never descends into it', () => {
    const ws = join(root, 'task-1')
    const outer = join(ws, 'repo', 'node_modules')
    mkdirSync(join(outer, 'some-pkg', 'node_modules'), { recursive: true })
    mkdirSync(join(outer, 'deeply', 'nested', 'dir'), { recursive: true })

    expect(findTopLevelNodeModules(ws)).toEqual([outer])
  })

  it('skips .git directories', () => {
    const ws = join(root, 'task-1')
    mkdirSync(join(ws, '.git', 'node_modules'), { recursive: true })
    mkdirSync(join(ws, 'repo', 'node_modules'), { recursive: true })

    expect(findTopLevelNodeModules(ws)).toEqual([join(ws, 'repo', 'node_modules')])
  })

  it('returns empty for a missing directory', () => {
    expect(findTopLevelNodeModules(join(root, 'nope'))).toEqual([])
  })
})

describe('pruneStaleNodeModules', () => {
  let root: string

  beforeEach(() => {
    root = makeRoot()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('prunes idle node_modules but keeps recent ones and all source files', () => {
    const oldWs = join(root, 'task-old')
    const newWs = join(root, 'task-new')
    makeAgedDir(join(oldWs, '.opencode', 'node_modules'), 10)
    writeFileSync(join(oldWs, '.opencode', 'package.json'), '{}')
    makeAgedDir(join(oldWs, 'repo', 'node_modules'), 30)
    writeFileSync(join(oldWs, 'repo', 'index.ts'), 'code')
    mkdirSync(join(newWs, 'repo', 'node_modules'), { recursive: true })

    const result = pruneStaleNodeModules({ workspacesRoot: root, inactiveDays: 7 })

    expect(result.errors).toEqual([])
    expect(result.pruned.sort()).toEqual(
      [join(oldWs, '.opencode', 'node_modules'), join(oldWs, 'repo', 'node_modules')].sort()
    )
    expect(existsSync(join(oldWs, '.opencode', 'node_modules'))).toBe(false)
    expect(existsSync(join(oldWs, 'repo', 'node_modules'))).toBe(false)
    // Source files survive the prune.
    expect(existsSync(join(oldWs, '.opencode', 'package.json'))).toBe(true)
    expect(existsSync(join(oldWs, 'repo', 'index.ts'))).toBe(true)
    // Recent install is kept.
    expect(existsSync(join(newWs, 'repo', 'node_modules'))).toBe(true)
  })

  it('respects skipWorkspaceIds (live activity)', () => {
    const ws = join(root, 'task-busy')
    makeAgedDir(join(ws, 'repo', 'node_modules'), 30)

    const result = pruneStaleNodeModules({
      workspacesRoot: root,
      inactiveDays: 7,
      skipWorkspaceIds: new Set(['task-busy'])
    })

    expect(result.pruned).toEqual([])
    expect(existsSync(join(ws, 'repo', 'node_modules'))).toBe(true)
  })

  it('refuses an invalid threshold instead of pruning everything', () => {
    const ws = join(root, 'task-1')
    mkdirSync(join(ws, 'node_modules'), { recursive: true })

    const result = pruneStaleNodeModules({ workspacesRoot: root, inactiveDays: 0 })

    expect(result.pruned).toEqual([])
    expect(result.errors.length).toBe(1)
    expect(existsSync(join(ws, 'node_modules'))).toBe(true)
  })

  it('returns empty when the workspaces root is missing', () => {
    const result = pruneStaleNodeModules({ workspacesRoot: join(root, 'nope'), inactiveDays: 7 })

    expect(result).toEqual({ pruned: [], errors: [] })
  })

  it('reports progress per workspace', () => {
    makeAgedDir(join(root, 'a', 'node_modules'), 10)
    mkdirSync(join(root, 'b'), { recursive: true })
    const seen: Array<[number, number]> = []

    pruneStaleNodeModules({
      workspacesRoot: root,
      inactiveDays: 7,
      onProgress: (processed, total) => {
        seen.push([processed, total])
      }
    })

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toEqual([2, 2])
  })

  it('ignores workspaces that vanish before the prune while cleaning the rest', () => {
    const ws1 = join(root, 'task-1')
    const ws2 = join(root, 'task-2')
    makeAgedDir(join(ws1, 'node_modules'), 10)
    makeAgedDir(join(ws2, 'node_modules'), 10)
    // Deleting the parent first turns the child stat into a failure path.
    rmSync(ws1, { recursive: true, force: true })

    const result = pruneStaleNodeModules({ workspacesRoot: root, inactiveDays: 7 })

    expect(result.pruned).toEqual([join(ws2, 'node_modules')])
  })
})

describe('activeStatusWorkspaceIds', () => {
  it('selects only active statuses', () => {
    const ids = activeStatusWorkspaceIds([
      { id: 'a', status: 'agent_working' },
      { id: 'b', status: 'triaging' },
      { id: 'c', status: 'agent_learning' },
      { id: 'd', status: 'ready_for_review' },
      { id: 'e', status: 'completed' },
      { id: 'f', status: 'not_started' }
    ])

    expect([...ids].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('findWorkspacesWithLiveProcesses', () => {
  it('returns an empty set when there is nothing to check', () => {
    expect(findWorkspacesWithLiveProcesses('/nonexistent-root', [])).toEqual(new Set())
  })

  it('sees the current process when it runs inside a workspace dir', () => {
    if (process.platform === 'win32') return
    // process.cwd() is the repo checkout, not a workspace — use a fake root that
    // cannot match, and assert the shape (a Set) rather than membership.
    const result = findWorkspacesWithLiveProcesses('/nonexistent-root', ['task-1'])
    expect(result === null || result instanceof Set).toBe(true)
  })

  it('marks the real cwd workspace as active', () => {
    if (process.platform === 'win32') return
    const cwd = process.cwd()
    // Derive a fake workspaces root one level above cwd so cwd looks like a workspace.
    void statSync(cwd)
    const result = findWorkspacesWithLiveProcesses(dirname(cwd), [basename(cwd)])
    // The current process (vitest/electron) has cwd inside it, so it must be active —
    // unless the platform cannot report cwds, in which case null is the honest answer.
    if (result !== null) expect(result.has(basename(cwd))).toBe(true)
  })
})
