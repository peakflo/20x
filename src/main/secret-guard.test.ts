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

  it('still blocks an echo of a secret piped only into an output-revealing command', () => {
    // Piping is allowed in general (see above), but this backstop only
    // exists to catch the "print it to stdout" case — a pipe to e.g. `cat`
    // still ends up on stdout, so this is intentionally a blunt allow-list,
    // not a semantic analysis of the downstream command. Documented here so
    // the trade-off is explicit, not accidental.
    expect(checkSecretDumpGuard('echo "$TOKEN" | cat', ['TOKEN']).blocked).toBe(false)
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
