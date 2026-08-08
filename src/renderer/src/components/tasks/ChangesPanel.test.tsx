import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { changes, files, readFile } = vi.hoisted(() => ({ changes: vi.fn(), files: vi.fn(), readFile: vi.fn() }))
vi.mock('@/lib/ipc-client', () => ({ worktreeApi: { changes, files, readFile } }))

import { ChangesPanel } from './ChangesPanel'

const persisted = new Map<string, string>()
vi.stubGlobal('localStorage', {
  clear: () => persisted.clear(),
  getItem: (key: string) => persisted.get(key) ?? null,
  setItem: (key: string, value: string) => persisted.set(key, value),
  removeItem: (key: string) => persisted.delete(key),
  key: (index: number) => [...persisted.keys()][index] ?? null,
  get length() { return persisted.size }
})

const diff = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index 1111111..2222222 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,2 +1,2 @@
-export const label = 'Old'
+export const label = 'New'
 export const size = 'sm'
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const created = true
+export const count = 1
`

beforeEach(() => {
  persisted.clear()
  const inventory = [{
    repo: 'Task workspace',
    allFiles: ['.agents/skills/ui/SKILL.md', 'AGENTS.md', 'attachments/spec.pdf'],
    workspace: true
  }, {
    repo: 'peakflo/20x',
    allFiles: ['README.md', 'package.json', 'src/components/Button.tsx', 'src/new.ts', 'src/unchanged.ts']
  }]
  files.mockReset().mockResolvedValue(inventory)
  changes.mockReset().mockResolvedValue([{
    ...inventory[0],
    diff: ''
  }, {
    ...inventory[1],
    diff,
    branch: 'feature/changes',
    pushed: true
  }])
  readFile.mockReset().mockImplementation(async (_taskId: string, repo: string | null, path: string) => {
    const content = `contents of ${repo || 'task workspace'}/${path}`
    return { content, size: content.length, binary: false, truncated: false }
  })
})

afterEach(cleanup)

describe('ChangesPanel', () => {
  it('shows All files before the diff calculation finishes', async () => {
    let resolveChanges: (value: unknown) => void = () => undefined
    changes.mockReturnValueOnce(new Promise((resolve) => { resolveChanges = resolve }))

    render(<ChangesPanel taskId="task-1" repos={['peakflo/20x']} />)

    expect(await screen.findByText('AGENTS.md')).toBeInTheDocument()
    expect(screen.getByText('package.json')).toBeInTheDocument()
    expect(screen.getByTitle('Refresh')).toBeDisabled()

    resolveChanges([])
    await waitFor(() => expect(screen.getByTitle('Refresh')).not.toBeDisabled())
  })

  it('shows the repository inventory in All files and preserves the tree in Diff', async () => {
    render(<ChangesPanel taskId="task-1" repos={['peakflo/20x']} />)

    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.getAllByText('Task workspace').length).toBeGreaterThan(0)
    expect(screen.getByText('AGENTS.md')).toBeInTheDocument()
    expect(screen.getByText('attachments')).toBeInTheDocument()
    expect(screen.queryByText('components')).not.toBeInTheDocument()
    expect(screen.queryByText('Button.tsx')).not.toBeInTheDocument()
    expect(screen.getByText('package.json')).toBeInTheDocument()
    expect(screen.getAllByText('README.md').length).toBeGreaterThan(0)
    expect(await screen.findByText('contents of task workspace/.agents/skills/ui/SKILL.md')).toBeInTheDocument()

    fireEvent.click(screen.getByText('src').closest('button')!)
    expect(screen.getByText('components')).toBeInTheDocument()
    expect(screen.getByText('new.ts')).toBeInTheDocument()
    expect(screen.getByText('unchanged.ts')).toBeInTheDocument()
    expect(screen.queryByText('Button.tsx')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('unchanged.ts').closest('button')!)
    expect(await screen.findByText('contents of peakflo/20x/src/unchanged.ts')).toBeInTheDocument()
    expect(readFile).toHaveBeenCalledWith('task-1', 'peakflo/20x', 'src/unchanged.ts')

    fireEvent.click(screen.getByText('components').closest('button')!)
    expect(screen.getByText('Button.tsx')).toBeInTheDocument()
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('−1').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('Button.tsx').closest('button')!)
    expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument()
    expect(await screen.findByText('contents of peakflo/20x/src/components/Button.tsx')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Diff' }))
    await waitFor(() => expect(screen.queryAllByText('Task workspace')).toHaveLength(0))
    expect(screen.getByText('components')).toBeInTheDocument()
    expect(screen.queryByText('unchanged.ts')).not.toBeInTheDocument()
    expect(screen.queryByText('package.json')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'All files' }))
    await waitFor(() => expect(screen.queryByText('components')).not.toBeInTheDocument())
    fireEvent.click(screen.getByText('src').closest('button')!)
    expect(screen.getByText('unchanged.ts')).toBeInTheDocument()
  })
})
