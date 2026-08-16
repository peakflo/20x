/**
 * Guards against a module existing twice, once as .ts and once as .js.
 *
 * This repository had two such pairs, and both were harmful in the same way:
 * the build and the tests resolved different files, so the test suite could pass
 * while the shipped app ran older code.
 *
 *   - task-management-mcp: the build input was the .js, so the .ts never
 *     shipped, and a grep-the-source test kept the copies roughly in step.
 *   - mcp-tool-caller: index.ts imported './mcp-tool-caller.js', so the .js
 *     shipped while the tests imported the .ts. A method added to the .ts was
 *     missing at run time, and the app crashed on startup with
 *     "mcpToolCaller.setTaskManagementInvoker is not a function".
 *
 * A plain .js file with no .ts twin is fine. The voice workers and the
 * agent-installer scripts are plain JavaScript on purpose.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Every file git tracks under src/, so generated output is never considered. */
function trackedSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src'], { cwd: repoRoot, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean)
}

describe('no duplicate module implementations', () => {
  it('has no .js file that shadows a .ts file of the same name', () => {
    const twins = trackedSourceFiles()
      .filter((file) => file.endsWith('.js'))
      .filter((file) => existsSync(join(repoRoot, `${file.slice(0, -3)}.ts`)))

    expect(
      twins,
      'These .js files have a .ts twin. The build and the tests can resolve ' +
      'different copies, so a change to one of them may never ship. Keep the ' +
      '.ts and delete the .js.'
    ).toEqual([])
  })

  it('only writes a .js specifier when the target really is a .js file', () => {
    // Importing './x.js' when only x.ts exists works, because the bundler falls
    // back to the .ts. It also hides which file ships: index.ts imported
    // './mcp-tool-caller.js', so once a real .js appeared beside the .ts, the
    // build silently switched to it. Requiring the extension to be truthful
    // removes that ambiguity. A genuine .js module, such as the agent-installer
    // scripts, is imported with .js and passes.
    const offenders: string[] = []
    const specifier = /from\s*['"](\.{1,2}\/[^'"]*\.js)['"]/g

    for (const file of trackedSourceFiles()) {
      if (!/\.(ts|tsx)$/.test(file)) continue
      const path = join(repoRoot, file)
      // A tracked file can be missing from the working tree mid-rebase.
      if (!existsSync(path)) continue
      const source = readFileSync(path, 'utf-8')
      for (const match of source.matchAll(specifier)) {
        const target = resolve(dirname(path), match[1])
        if (!existsSync(target)) offenders.push(`${file} -> ${match[1]}`)
      }
    }

    expect(
      offenders,
      'These .js specifiers have no .js file behind them. Drop the extension so ' +
      'the import cannot switch targets when a .js file appears.'
    ).toEqual([])
  })
})
