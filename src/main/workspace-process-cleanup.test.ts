import { describe, it, expect } from 'vitest'
import { parseProcessTable } from './mcp-process-cleanup'
import {
  parseLsofCwd,
  workspaceIdForCwd,
  collectAncestorPids,
  buildWorkspaceStates,
  selectLeakedWorkspaceRoots,
  selectLeakedWorkspacePids,
  selectPidsRootedInWorkspaces,
  ACTIVE_TASK_STATUSES,
  type CwdRow
} from './workspace-process-cleanup'

const ROOT = '/Users/dev/Library/Application Support/20x/workspaces'
const WS = (id: string, tail = '') => `${ROOT}/${id}${tail}`

/** The real command line of the two processes measured holding 20,341 descriptors. */
const TSX_WATCH =
  'node /Users/dev/Library/Application Support/20x/workspaces/task_A/workflow-builder/packages/workflow-api/node_modules/.bin/tsx watch src/index.ts'
/** The owner's own work, outside the workspaces root, with a near-identical command. */
const USER_TSX_WATCH =
  'node /Users/dev/Documents/codes/peakflo/sources/other/pf-workflo/packages/workflow-api/node_modules/.bin/tsx watch src/index.ts'

function cwds(pairs: [number, string][]): CwdRow[] {
  return pairs.map(([pid, cwd]) => ({ pid, cwd }))
}

describe('parseLsofCwd', () => {
  it('pairs each p line with its own n line', () => {
    expect(parseLsofCwd(['p101', 'n/tmp/a', 'p102', 'n/tmp/b'].join('\n'))).toEqual([
      { pid: 101, cwd: '/tmp/a' },
      { pid: 102, cwd: '/tmp/b' }
    ])
  })

  it('drops a p line with no path instead of pairing it with the next process', () => {
    // A process that exits mid-scan prints no n line. Carrying the pid forward
    // would attribute another process's directory to it — and that directory
    // decides whether it is killed.
    expect(parseLsofCwd(['p101', 'p102', 'n/tmp/b'].join('\n'))).toEqual([{ pid: 102, cwd: '/tmp/b' }])
  })

  it('takes one cwd per process, not a second row from a stray extra n line', () => {
    // A process has exactly one cwd. A second `n` line under the same `p` is
    // not a second process, and inventing one would put a pid into the kill
    // list under a directory it is not running in.
    expect(parseLsofCwd(['p101', 'n/tmp/a', 'n/tmp/b'].join('\n'))).toEqual([{ pid: 101, cwd: '/tmp/a' }])
  })

  it('ignores an unparseable pid', () => {
    expect(parseLsofCwd(['pnot-a-number', 'n/tmp/a'].join('\n'))).toEqual([])
  })
})

describe('workspaceIdForCwd', () => {
  it('returns the workspace directory name for a path inside it', () => {
    expect(workspaceIdForCwd(WS('task_A', '/repo/packages/api'), ROOT)).toBe('task_A')
    expect(workspaceIdForCwd(WS('task_A'), ROOT)).toBe('task_A')
  })

  it('returns null for a path outside the root — the regression that matters most', () => {
    expect(workspaceIdForCwd('/Users/dev/Documents/codes/peakflo/sources/other/pf-workflo', ROOT)).toBeNull()
  })

  it('returns null for a sibling directory that merely shares the prefix', () => {
    // `startsWith` on the raw string would match this and kill a process in it.
    expect(workspaceIdForCwd(`${ROOT}-backup/task_A/repo`, ROOT)).toBeNull()
    expect(workspaceIdForCwd(`${ROOT}2/task_A`, ROOT)).toBeNull()
  })

  it('returns null for the root itself — a shell there is in no task workspace', () => {
    // Measured on the machine: one zsh sat in exactly this directory. It is in
    // no task workspace, so no task state can ever declare it leaked.
    expect(workspaceIdForCwd(ROOT, ROOT)).toBeNull()
    expect(workspaceIdForCwd(`${ROOT}/`, ROOT)).toBeNull()
    expect(workspaceIdForCwd(`${ROOT}/.`, ROOT)).toBeNull()
  })

  it('resolves .. before deciding, so a path cannot climb out and still match', () => {
    expect(workspaceIdForCwd(`${ROOT}/task_A/../../elsewhere`, ROOT)).toBeNull()
  })

  it('returns null for a relative path', () => {
    expect(workspaceIdForCwd('task_A/repo', ROOT)).toBeNull()
  })
})

describe('collectAncestorPids', () => {
  it('walks up to the top and stops at launchd', () => {
    const rows = parseProcessTable([' 10 1 launched-app', ' 11 10 shell', ' 12 11 me'].join('\n'))
    expect(collectAncestorPids(rows, 12)).toEqual(new Set([11, 10]))
  })

  it('terminates on a parent cycle', () => {
    const rows = parseProcessTable([' 10 11 a', ' 11 10 b'].join('\n'))
    expect(collectAncestorPids(rows, 10)).toEqual(new Set([11, 10]))
  })
})

describe('buildWorkspaceStates', () => {
  it('marks a directory with no task as unowned, and a task with no directory as gone', () => {
    const states = buildWorkspaceStates(
      [{ id: 'task_A', status: 'agent_working' }, { id: 'task_gone', status: 'completed' }],
      ['task_A', 'orphan_dir']
    )
    expect(states.get('task_A')).toEqual({ status: 'agent_working', exists: true })
    expect(states.get('orphan_dir')).toEqual({ exists: true })
    expect(states.get('task_gone')).toEqual({ status: 'completed', exists: false })
  })
})

describe('selectLeakedWorkspaceRoots', () => {
  const base = (rows: string[], cwdRows: CwdRow[], states: Record<string, { status?: string; exists: boolean }>) => ({
    rows: parseProcessTable(rows.join('\n')),
    cwdRows,
    workspacesRoot: ROOT,
    ownPid: 10,
    workspaceState: (id: string) => states[id] ?? { exists: false }
  })

  it('kills an orphaned watcher rooted in a finished task workspace', () => {
    const input = base(
      [' 10 1 20x-main', ' 77531 1 ' + TSX_WATCH],
      cwds([[77531, WS('task_A', '/workflow-builder/packages/workflow-api')]]),
      { task_A: { status: 'completed', exists: true } }
    )
    expect(selectLeakedWorkspaceRoots(input).map((leak) => leak.pid)).toEqual([77531])
  })

  it("LEAVES the user's own watcher alone, though its command line is near-identical", () => {
    // This is the regression that destroys running work. The command matches
    // `tsx watch` exactly; only the cwd differs, and only the cwd decides.
    const input = base(
      [' 10 1 20x-main', ' 4242 1 ' + USER_TSX_WATCH],
      cwds([[4242, '/Users/dev/Documents/codes/peakflo/sources/other/pf-workflo/packages/workflow-api']]),
      {}
    )
    expect(selectLeakedWorkspaceRoots(input)).toEqual([])
    expect(selectLeakedWorkspacePids(input)).toEqual([])
  })

  it('leaves a watcher in a workspace whose task is still being worked on', () => {
    for (const status of ACTIVE_TASK_STATUSES) {
      const input = base(
        [' 10 1 20x-main', ' 500 1 ' + TSX_WATCH],
        cwds([[500, WS('task_A', '/repo')]]),
        { task_A: { status, exists: true } }
      )
      expect(selectLeakedWorkspaceRoots(input), `status ${status}`).toEqual([])
    }
  })

  it('kills a workspace process for a task in ready_for_review — nobody is driving it', () => {
    const input = base(
      [' 10 1 20x-main', ' 500 1 ' + TSX_WATCH],
      cwds([[500, WS('task_A', '/repo')]]),
      { task_A: { status: 'ready_for_review', exists: true } }
    )
    expect(selectLeakedWorkspaceRoots(input).map((leak) => leak.pid)).toEqual([500])
  })

  it('kills a process whose workspace directory has already been removed', () => {
    const input = base(
      [' 10 1 20x-main', ' 500 1 ' + TSX_WATCH],
      cwds([[500, WS('task_gone', '/repo')]]),
      { task_gone: { status: 'completed', exists: false } }
    )
    expect(selectLeakedWorkspaceRoots(input)[0].reason).toContain('workspace directory removed')
  })

  it('but a missing directory does NOT override an active task', () => {
    // This assertion is the reverse of what this file first said. A missing
    // directory is far more often a failed listing than a deleted workspace —
    // `readdirSync` needs a descriptor and so fails early under EMFILE, the
    // very condition this feature relieves. Letting it outrank the active-task
    // guard made the sweep most destructive on exactly the machine it is for.
    const input = base(
      [' 10 1 20x-main', ' 500 1 ' + TSX_WATCH],
      cwds([[500, WS('task_live', '/repo')]]),
      { task_live: { status: 'agent_working', exists: false } }
    )
    expect(selectLeakedWorkspaceRoots(input)).toEqual([])
  })

  it('keeps a workspace process held by ANOTHER live 20x instance', () => {
    // pid 20 is a second instance with a running agent. Its child must survive
    // our shutdown — the regression the blind pkill caused for MCP servers.
    const input = base(
      [' 10 1 20x-ours', ' 20 1 20x-theirs', ' 21 20 ' + TSX_WATCH],
      cwds([[21, WS('task_A', '/repo')]]),
      { task_A: { status: 'completed', exists: true } }
    )
    expect(selectLeakedWorkspaceRoots(input)).toEqual([])
  })

  it('kills its own descendant at shutdown, even though the parent is alive', () => {
    const input = base(
      [' 10 1 20x-ours', ' 11 10 pnpm', ' 12 11 ' + TSX_WATCH],
      cwds([[12, WS('task_A', '/repo')]]),
      { task_A: { status: 'completed', exists: true } }
    )
    expect(selectLeakedWorkspaceRoots(input).map((leak) => leak.pid)).toEqual([12])
  })

  it('never selects itself or an ancestor, even when 20x runs from inside a workspace', () => {
    // A dev build of 20x is normally checked out into a task workspace, so its
    // own cwd is under the root. Killing itself or its launcher would be fatal.
    const input = base(
      [' 5 1 terminal', ' 10 5 20x-dev-build'],
      cwds([[5, WS('task_A', '/20x')], [10, WS('task_A', '/20x')]]),
      { task_A: { status: 'completed', exists: true } }
    )
    expect(selectLeakedWorkspaceRoots(input)).toEqual([])
  })

  it('ignores a process with no readable cwd', () => {
    const input = base([' 10 1 20x-main', ' 500 1 ' + TSX_WATCH], [], { task_A: { status: 'completed', exists: true } })
    expect(selectLeakedWorkspaceRoots(input)).toEqual([])
  })
})

describe('descendants of a leaked root', () => {
  const rows = parseProcessTable(
    [' 10 1 20x-main', ' 900 1 tmux-server', ' 901 900 nvim', ' 902 900 ' + USER_TSX_WATCH, ' 903 900 node'].join('\n')
  )
  const input = {
    rows,
    cwdRows: cwds([
      [900, WS('task_done')],
      [901, '/Users/dev/Documents/mynotes'],
      [902, '/Users/dev/Documents/codes/peakflo/sources/other/pf-workflo/packages/workflow-api'],
      [903, WS('task_done', '/repo')]
    ]),
    workspacesRoot: ROOT,
    ownPid: 10,
    workspaceState: () => ({ status: 'completed', exists: true })
  }

  it('takes a descendant that is itself inside the workspace', () => {
    // The measured shape: the matched orphan held 49 descriptors, the browser
    // it started held 449. Stopping at the root leaves the leak behind.
    expect(selectLeakedWorkspacePids(input)).toContain(903)
  })

  it("NEVER takes a descendant whose own cwd is outside the root", () => {
    // A `tmux` or `screen` server started inside a workspace is ppid 1 by
    // DESIGN, so a finished task selects it. Its panes are its descendants and
    // their cwds are wherever the user put them. Without this rule one finished
    // task took down the user's editor and their dev server in their own
    // checkout — the catastrophe this module exists to avoid, from the other
    // direction.
    const selected = selectLeakedWorkspacePids(input)
    expect(selected).not.toContain(901)
    expect(selected).not.toContain(902)
    expect(selected).toEqual([900, 903])
  })

  it('leaves a descendant with no readable cwd alone — not readable is not leaked', () => {
    const noCwd = { ...input, cwdRows: cwds([[900, WS('task_done')]]) }
    expect(selectLeakedWorkspacePids(noCwd)).toEqual([900])
  })
})

describe('an active task is an absolute veto', () => {
  const base = (ppid: number, state: { status?: string; exists: boolean }, orphansIgnoreTaskState = false) => ({
    rows: parseProcessTable([' 10 1 20x-main', ` 500 ${ppid} ` + TSX_WATCH].join('\n')),
    cwdRows: cwds([[500, WS('task_A', '/repo')]]),
    workspacesRoot: ROOT,
    ownPid: 10,
    workspaceState: () => state,
    orphansIgnoreTaskState
  })

  it('outranks a missing directory, which is far more likely a failed listing', () => {
    // If this loses, one unreadable directory listing kills the workspace of
    // every task an agent is working on right now.
    expect(selectLeakedWorkspaceRoots(base(1, { status: 'agent_working', exists: false }))).toEqual([])
  })

  it('protects our own descendant even at boot', () => {
    expect(selectLeakedWorkspaceRoots(base(10, { status: 'agent_working', exists: true }, true))).toEqual([])
  })

  it('does NOT protect a parentless process at boot — the force-quit case', () => {
    // `stopAllSessions` preserves task status across a quit and nothing repairs
    // it at startup, so a force-quit task stays `agent_working` forever. If the
    // status wins here, the leaked watcher is vetoed on every boot from then on
    // and the reported bug is never fixed.
    const leaked = selectLeakedWorkspaceRoots(base(1, { status: 'agent_working', exists: true }, true))
    expect(leaked.map((entry) => entry.pid)).toEqual([500])
    expect(leaked[0].reason).toContain('parentless at startup')
  })

  it('still protects a parentless process when that flag is off — the shutdown sweep', () => {
    expect(selectLeakedWorkspaceRoots(base(1, { status: 'agent_working', exists: true }, false))).toEqual([])
  })
})

describe('selectLeakedWorkspacePids', () => {
  it('takes the whole tree, because the descendants hold the descriptors', () => {
    // Measured shape: a 49-fd orphaned `node` whose `firefox` child held 449 more.
    const rows = parseProcessTable(
      [' 10 1 20x-main', ' 18999 1 node', ' 19102 18999 firefox', ' 19284 19102 plugin-container'].join('\n')
    )
    const pids = selectLeakedWorkspacePids({
      rows,
      cwdRows: cwds([[18999, WS('task_A', '/cp')], [19102, WS('task_A', '/cp')], [19284, WS('task_A', '/cp')]]),
      workspacesRoot: ROOT,
      ownPid: 10,
      workspaceState: () => ({ status: 'completed', exists: true })
    })
    expect(pids).toEqual([18999, 19102, 19284])
  })
})

describe('selectPidsRootedInWorkspaces', () => {
  const rows = parseProcessTable(
    [' 10 1 20x-main', ' 11 10 pnpm', ' 12 11 ' + TSX_WATCH, ' 20 1 20x-theirs', ' 21 20 ' + TSX_WATCH, ' 42 1 ' + USER_TSX_WATCH].join('\n')
  )
  const cwdRows = cwds([
    [12, WS('task_A', '/repo')],
    [21, WS('task_A', '/repo')],
    [42, '/Users/dev/Documents/codes/peakflo/sources/other/pf-workflo']
  ])

  it("takes a process held by ANOTHER instance, because that directory is going", () => {
    // The scope rule does not apply on this path and must not: the directory is
    // being deleted, so a process still running in it cannot be left behind,
    // and whose child it is does not change that. pid 12 is OUR child and is
    // excluded — the sweep owns what we own, judged on task state.
    expect(selectPidsRootedInWorkspaces({ rows, cwdRows, workspacesRoot: ROOT, ownPid: 10, workspaceIds: ['task_A'] })).toEqual([21])
  })

  it('still leaves a process outside the root alone', () => {
    expect(selectPidsRootedInWorkspaces({ rows, cwdRows, workspacesRoot: ROOT, ownPid: 10, workspaceIds: ['task_A'] })).not.toContain(42)
  })

  it('takes nothing for a workspace that is not being removed', () => {
    expect(selectPidsRootedInWorkspaces({ rows, cwdRows, workspacesRoot: ROOT, ownPid: 10, workspaceIds: ['task_B'] })).toEqual([])
  })

  it('never selects itself, an ancestor, OR ANY OF OUR OWN CHILDREN', () => {
    // A dev build of 20x lives inside a task workspace, so the main process's
    // cwd IS that workspace and every child inherits it — `opencode serve`, the
    // stdio MCP children, git. Protecting only self and ancestors meant that
    // once that task passed the retention window the daily cleanup killed the
    // running app's whole subprocess tree, every live agent session with it,
    // and then deleted the directory underneath.
    const own = parseProcessTable(
      [' 5 1 shell', ' 10 5 20x-dev', ' 12 10 opencode-serve', ' 13 12 mcp-child', ' 99 1 stranger'].join('\n')
    )
    const ownCwds = cwds([[5, WS('task_A')], [10, WS('task_A')], [12, WS('task_A')], [13, WS('task_A')], [99, WS('task_A')]])
    const selected = selectPidsRootedInWorkspaces({ rows: own, cwdRows: ownCwds, workspacesRoot: ROOT, ownPid: 10, workspaceIds: ['task_A'] })
    expect(selected).toEqual([99])
  })

  it('does not follow a tree out of the workspaces root', () => {
    const tree = parseProcessTable([' 10 1 20x-main', ' 900 1 tmux', ' 901 900 nvim'].join('\n'))
    const treeCwds = cwds([[900, WS('task_A')], [901, '/Users/dev/Documents/mynotes']])
    expect(selectPidsRootedInWorkspaces({ rows: tree, cwdRows: treeCwds, workspacesRoot: ROOT, ownPid: 10, workspaceIds: ['task_A'] })).toEqual([900])
  })
})
