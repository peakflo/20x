import { describe, expect, it } from 'vitest'
import { checkSecretDumpGuard, checkLoaderReadGuard, buildGuardFunctionSource } from './secret-guard'

const BLOCKED_COMMANDS = [
  'env',
  'env -i',
  'env -0', // NUL-delimited dump — digit flag, not just letters
  'cd /tmp && env',
  'echo start; env; echo done',
  'printenv',
  'printenv HOME',
  'set',
  '  set  ',
  'export', // bare export, no args — dumps every exported var
  'export -p',
  'declare -p',
  'declare -x',
  'declare -xp', // combined short flags
  'declare -px',
  'typeset -p',
  'compgen -e',
  'cat /proc/self/environ',
  'cat /proc/1234/environ',
  'ps e',
  'ps eww',
  'ps -E',
  'command env', // bypasses a shell alias/function named env
  'sudo env', // wrapper prefix stripped before matching
  'exec printenv',
  'FOO=bar env' // a var assignment prefix is just a wrapper, not a scoping sub-command
]

const ALLOWED_COMMANDS = [
  'echo hi',
  'ls -la',
  'git status',
  'npm test',
  'env FOO=bar node server.js', // scopes one var to a sub-command, not a dump
  'set -e',
  'set -o pipefail',
  'declare -x MY_VAR=value', // sets/exports, does not print
  'ps -ef',
  'ps aux',
  'curl -sf https://example.com',
  'export MY_VAR=value', // plain export, not export -p
  // Position-based false positives (re-review, P2): the word appears as
  // ARGUMENT TEXT to an unrelated command, not as the command being run.
  'grep -r printenv src',
  'git commit -m "fixed a printenv bug"',
  'echo "declare -p is scary" > notes.txt',
  'echo "export -p prints secrets" | wc -l'
]

describe('checkSecretDumpGuard', () => {
  it.each(BLOCKED_COMMANDS)('blocks: %s', (command) => {
    expect(checkSecretDumpGuard(command).blocked).toBe(true)
  })

  it.each(ALLOWED_COMMANDS)('allows: %s', (command) => {
    expect(checkSecretDumpGuard(command).blocked).toBe(false)
  })

  it('includes a helpful, non-secret-revealing reason when blocked', () => {
    const result = checkSecretDumpGuard('env')
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("don't need to print them")
    expect(result.reason).not.toMatch(/[A-Za-z0-9+/]{20,}/) // no embedded secret-shaped blob
  })

  it('blocks echo/printf of a known secret var name', () => {
    expect(checkSecretDumpGuard('echo $MY_SECRET', ['MY_SECRET']).blocked).toBe(true)
    expect(checkSecretDumpGuard('echo ${MY_SECRET}', ['MY_SECRET']).blocked).toBe(true)
    expect(checkSecretDumpGuard('printf "%s" "$MY_SECRET"', ['MY_SECRET']).blocked).toBe(true)
  })

  it('does not block echo of an unrelated variable', () => {
    expect(checkSecretDumpGuard('echo $HOME', ['MY_SECRET']).blocked).toBe(false)
  })

  it('does not block echo of a secret var name when no var names are known', () => {
    expect(checkSecretDumpGuard('echo $MY_SECRET').blocked).toBe(false)
  })

  it('checks every segment of a compound command, not just the first', () => {
    expect(checkSecretDumpGuard('ls && printenv').blocked).toBe(true)
    expect(checkSecretDumpGuard('ls | printenv').blocked).toBe(true)
    expect(checkSecretDumpGuard('ls\nenv').blocked).toBe(true)
  })

  // Re-review (P2): piping a known secret var into ANOTHER command's stdin
  // is a standard, safe credential-handoff pattern — not a dump to visible
  // output — and must be allowed.
  it('allows a known secret var piped into another command — standard safe patterns', () => {
    expect(checkSecretDumpGuard('echo "$TOKEN" | gh auth login --with-token', ['TOKEN']).blocked).toBe(false)
    expect(
      checkSecretDumpGuard('printf %s "$TOKEN" | docker login --password-stdin', ['TOKEN']).blocked
    ).toBe(false)
  })

  it('still blocks the same echo when it is NOT piped anywhere', () => {
    expect(checkSecretDumpGuard('echo "$TOKEN"', ['TOKEN']).blocked).toBe(true)
    expect(checkSecretDumpGuard('printf %s "$TOKEN"', ['TOKEN']).blocked).toBe(true)
  })

  // Re-review (round 3, P2): the first version of this fix allowed ANY `|`
  // after the matched echo/printf — `| cat`, `| tee file`, `| rev` all
  // slipped through too, which is just the dump guard bypassed via one
  // extra pipe stage. Only a recognized credential-handoff sink is allowed
  // now; anything else piped into is still blocked.
  it('still blocks an echo of a secret piped into a plain output-revealing command', () => {
    expect(checkSecretDumpGuard('echo "$TOKEN" | cat', ['TOKEN']).blocked).toBe(true)
    expect(checkSecretDumpGuard('echo "$TOKEN" | tee leaked.txt', ['TOKEN']).blocked).toBe(true)
    expect(checkSecretDumpGuard('echo "$TOKEN" | rev', ['TOKEN']).blocked).toBe(true)
  })

  it('still blocks when a later pipeline stage is unsafe, even after a safe one', () => {
    expect(
      checkSecretDumpGuard('echo "$TOKEN" | gh auth login --with-token | tee leaked.txt', ['TOKEN']).blocked
    ).toBe(true)
  })

  it('recognizes the other named safe sinks too (npm, helm)', () => {
    expect(checkSecretDumpGuard('echo "$TOKEN" | npm login --authtoken', ['TOKEN']).blocked).toBe(false)
    expect(checkSecretDumpGuard('echo "$TOKEN" | helm registry login --password-stdin', ['TOKEN']).blocked).toBe(false)
  })

  // Bug, re-review (round 4, P1): the original fix's generic fallback
  // (`\S+\s+(?:login|auth\s+login)\b[^\n]*--(?:with-token|password-stdin)\b`)
  // matched FAR too loosely — any command word, "login" as plain argument
  // text (not necessarily a subcommand), and the flag as a substring
  // anywhere later rather than a real standalone argument. This exact
  // command satisfied all three without actually being a credential
  // handoff at all: `tee` is not a login CLI, "login" here is just its
  // output filename, and "--password-stdin" is a substring of
  // "./--password-stdin", not a flag. The generic fallback is removed
  // entirely now — only the named CLIs above are recognized, and a CLI
  // not on that list (glab, az, or anything else) is blocked too, even
  // with a real --with-token/--password-stdin flag.
  it('BLOCKS the tee/login/--password-stdin bypass the generic fallback used to allow', () => {
    expect(checkSecretDumpGuard('echo "$TOKEN" | tee login ./--password-stdin', ['TOKEN']).blocked).toBe(true)
  })

  it('a CLI not on the named list is still blocked, even with a real-looking --with-token flag (the generic fallback is gone)', () => {
    expect(checkSecretDumpGuard('echo "$TOKEN" | glab auth login --with-token', ['TOKEN']).blocked).toBe(true)
  })

  // Defense in depth for the NAMED patterns too: the flag must be its own
  // whitespace-delimited argument, not a substring glued onto another
  // token.
  it('a named CLI with the flag glued onto another argument (not a real flag token) is still blocked', () => {
    expect(checkSecretDumpGuard('echo "$TOKEN" | docker login ./--password-stdin', ['TOKEN']).blocked).toBe(true)
    expect(checkSecretDumpGuard('echo "$TOKEN" | gh auth login ./--with-token', ['TOKEN']).blocked).toBe(true)
  })
})

describe('checkLoaderReadGuard', () => {
  const loaderPath = '/Users/me/Library/Application Support/20x/secret-loader/secret-loader.sh'

  it('blocks reading the loader script source', () => {
    expect(checkLoaderReadGuard(`cat '${loaderPath}'`, loaderPath).blocked).toBe(true)
    expect(checkLoaderReadGuard(`less ${loaderPath}`, loaderPath).blocked).toBe(true)
  })

  it('does not block invoking the loader (that is the whole point of it)', () => {
    expect(checkLoaderReadGuard(`eval "$('${loaderPath}' 5555 'tok' 2>/dev/null)"`, loaderPath).blocked).toBe(false)
  })

  it('does nothing when no loaderPath is given', () => {
    expect(checkLoaderReadGuard('cat /etc/hosts', undefined).blocked).toBe(false)
  })
})

describe('buildGuardFunctionSource — parity with checkSecretDumpGuard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generated = new Function(`${buildGuardFunctionSource()}; return checkSecretDumpGuard;`)() as any

  it.each([...BLOCKED_COMMANDS, ...ALLOWED_COMMANDS])('matches the TS implementation for: %s', (command) => {
    expect(generated(command, [], undefined).blocked).toBe(checkSecretDumpGuard(command).blocked)
  })

  it('blocks a known secret var name the same way', () => {
    expect(generated('echo $MY_SECRET', ['MY_SECRET'], undefined).blocked).toBe(true)
    expect(generated('echo $MY_SECRET', [], undefined).blocked).toBe(false)
  })

  it('allows a piped secret var the same way', () => {
    expect(generated('echo "$TOKEN" | gh auth login --with-token', ['TOKEN'], undefined).blocked).toBe(false)
    expect(generated('echo "$TOKEN"', ['TOKEN'], undefined).blocked).toBe(true)
  })

  it('blocks reading the loader source the same way', () => {
    const loaderPath = '/fake/secret-loader.sh'
    expect(generated(`cat ${loaderPath}`, [], loaderPath).blocked).toBe(true)
    expect(generated('echo hi', [], loaderPath).blocked).toBe(false)
  })
})
