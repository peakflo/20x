import { describe, expect, it } from 'vitest'
import { checkSecretDumpGuard, checkLoaderReadGuard, buildGuardFunctionSource } from './secret-guard'

const BLOCKED_COMMANDS = [
  'env',
  'env -i',
  'cd /tmp && env',
  'echo start; env; echo done',
  'printenv',
  'printenv HOME',
  'set',
  '  set  ',
  'export -p',
  'declare -p',
  'declare -x',
  'typeset -p',
  'cat /proc/self/environ',
  'cat /proc/1234/environ',
  'ps e',
  'ps eww',
  'ps -E'
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
  'export MY_VAR=value' // plain export, not export -p
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

  it('blocks reading the loader source the same way', () => {
    const loaderPath = '/fake/secret-loader.sh'
    expect(generated(`cat ${loaderPath}`, [], loaderPath).blocked).toBe(true)
    expect(generated('echo hi', [], loaderPath).blocked).toBe(false)
  })
})
