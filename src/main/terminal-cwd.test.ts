import { describe, expect, it } from 'vitest'
import { resolveTerminalCwd } from './terminal-cwd'

function fakeRunner(tree: Record<number, number[]>, cwds: Record<number, string>) {
  const calls: string[] = []
  const run = async (file: string, args: string[]): Promise<string> => {
    calls.push(`${file} ${args.join(' ')}`)
    if (file === 'pgrep') return (tree[Number(args[1])] ?? []).join('\n')
    if (file === 'lsof') {
      const cwd = cwds[Number(args[1])]
      return cwd ? `p${args[1]}\nfcwd\nn${cwd}\n` : ''
    }
    return ''
  }
  return { run, calls }
}

describe('resolveTerminalCwd', () => {
  it('walks to the deepest last child and reads its cwd', async () => {
    const { run } = fakeRunner({ 10: [11, 12], 12: [13] }, { 13: '/work/repo' })
    await expect(resolveTerminalCwd(10, run, 'darwin')).resolves.toBe('/work/repo')
  })

  it('uses the root pid when there are no children', async () => {
    const { run } = fakeRunner({}, { 10: '/home/me' })
    await expect(resolveTerminalCwd(10, run, 'darwin')).resolves.toBe('/home/me')
  })

  it('returns null when lsof reports nothing', async () => {
    const { run } = fakeRunner({ 10: [11] }, {})
    await expect(resolveTerminalCwd(10, run, 'darwin')).resolves.toBeNull()
  })

  it('stops walking after 5 levels', async () => {
    const tree: Record<number, number[]> = {}
    for (let i = 1; i < 20; i++) tree[i] = [i + 1]
    const { run, calls } = fakeRunner(tree, { 7: '/deep' })
    await expect(resolveTerminalCwd(1, run, 'darwin')).resolves.toBe('/deep')
    expect(calls.filter((c) => c.startsWith('pgrep'))).toHaveLength(6)
  })
})
