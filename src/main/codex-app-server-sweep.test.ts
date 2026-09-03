import { describe, it, expect } from 'vitest'
import { parseProcessTable } from './mcp-process-cleanup'
import { selectUntrackedAppServerPids, CODEX_APP_SERVER_MARKER } from './codex-app-server-sweep'

const WRAPPER = 'node /Users/x/.nvm/versions/node/v22.14.0/bin/codex app-server --stdio'
const NATIVE = 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex app-server --stdio'
const OBSERVABILITY = 'npm exec @google-cloud/observability-mcp'

/** The shape a real `ps -eo pid=,ppid=,command=` line has, built from tuples. */
function table(rows: Array<[number, number, string]>): ReturnType<typeof parseProcessTable> {
  return parseProcessTable(rows.map(([pid, ppid, command]) => `${pid} ${ppid} ${command}`).join('\n'))
}

describe('selectUntrackedAppServerPids', () => {
  it('leaves a tracked app-server and everything under it alone', () => {
    // The pair as it really appears: 20x -> node wrapper -> vendored binary ->
    // npm exec observability-mcp. Only the wrapper pid is ever tracked, so the
    // two processes beneath it must be spared by their depth, not by name.
    const rows = table([
      [100, 1, '20x'],
      [200, 100, WRAPPER],
      [201, 200, NATIVE],
      [202, 201, OBSERVABILITY]
    ])

    expect(selectUntrackedAppServerPids(rows, 100, new Set([200]))).toEqual([])
  })

  it('selects an app-server the adapter no longer holds', () => {
    // The leak: two wrappers under 20x, one of them replaced by a resume and no
    // longer in the ledger. Killing it takes the binary under it with it.
    const rows = table([
      [100, 1, '20x'],
      [200, 100, WRAPPER],
      [201, 200, NATIVE],
      [300, 100, WRAPPER],
      [301, 300, NATIVE]
    ])

    expect(selectUntrackedAppServerPids(rows, 100, new Set([300]))).toEqual([200])
  })

  it('never selects an app-server belonging to another 20x instance', () => {
    // A packaged app and a dev build side by side is normal. Killing by name
    // would take the other instance's live session with it.
    const rows = table([
      [100, 1, '20x (ours)'],
      [500, 1, '20x (theirs)'],
      [501, 500, WRAPPER],
      [502, 501, NATIVE]
    ])

    expect(selectUntrackedAppServerPids(rows, 100, new Set())).toEqual([])
  })

  it('leaves an app-server an agent session started for itself alone', () => {
    // The adapter always spawns directly, so depth means somebody else spawned
    // it — here a Codex-backed agent running Codex as part of the user's own
    // work. Untracked and ours, and still none of the sweep's business.
    const rows = table([
      [100, 1, '20x'],
      [150, 100, 'claude --output-format stream-json'],
      [200, 150, WRAPPER],
      [201, 200, NATIVE]
    ])

    expect(selectUntrackedAppServerPids(rows, 100, new Set())).toEqual([])
  })

  it('ignores our own children that are not app-servers', () => {
    const rows = table([
      [100, 1, '20x'],
      [200, 100, 'node task-management-mcp.js'],
      [201, 100, 'codex acp'],
      [202, 100, 'codex app-server --help'],
      [203, 100, 'git status']
    ])

    expect(selectUntrackedAppServerPids(rows, 100, new Set())).toEqual([])
  })

  it('leaves a parentless app-server to the boot sweep', () => {
    // A force-quit reparents these to launchd. They are nobody's child, so this
    // sweep cannot claim them and must not guess — the marker in
    // `mcp-process-cleanup` collects them at the next start, where
    // "parentless" is the whole test.
    const rows = table([
      [100, 1, '20x'],
      [200, 1, WRAPPER],
      [201, 200, NATIVE]
    ])

    expect(selectUntrackedAppServerPids(rows, 100, new Set())).toEqual([])
  })

  it('matches both halves of the pair, and neither of the other Codex commands', () => {
    expect(WRAPPER).toContain(CODEX_APP_SERVER_MARKER)
    expect(NATIVE).toContain(CODEX_APP_SERVER_MARKER)
    expect('codex acp').not.toContain(CODEX_APP_SERVER_MARKER)
    expect('codex app-server --help').not.toContain(CODEX_APP_SERVER_MARKER)
  })
})
