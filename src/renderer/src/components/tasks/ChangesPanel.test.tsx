import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { changes } = vi.hoisted(() => ({ changes: vi.fn() }))
vi.mock('@/lib/ipc-client', () => ({ worktreeApi: { changes } }))

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
  changes.mockReset().mockResolvedValue([{
    repo: 'peakflo/20x',
    diff,
    allFiles: ['README.md', 'package.json', 'src/components/Button.tsx', 'src/new.ts', 'src/unchanged.ts'],
    branch: 'feature/changes',
    pushed: true
  }])
})

afterEach(cleanup)

describe('ChangesPanel', () => {
  it('shows the repository inventory in All files and preserves the tree in Diff', async () => {
    render(<ChangesPanel taskId="task-1" repos={['peakflo/20x']} />)

    expect(await screen.findByText('components')).toBeInTheDocument()
    expect(screen.getByText('Button.tsx')).toBeInTheDocument()
    expect(screen.getByText('new.ts')).toBeInTheDocument()
    expect(screen.getByText('unchanged.ts')).toBeInTheDocument()
    expect(screen.getByText('package.json')).toBeInTheDocument()
    expect(screen.getAllByText('README.md').length).toBeGreaterThan(0)
    expect(await screen.findByText('This file has no changes in the task branch.')).toBeInTheDocument()
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('−1').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('Button.tsx').closest('button')!)
    expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument()
    expect(screen.getByText('Modified')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Diff' }))
    expect(screen.getByText('components')).toBeInTheDocument()
    expect(screen.queryByText('unchanged.ts')).not.toBeInTheDocument()
    expect(screen.queryByText('package.json')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'All files' }))
    expect(screen.getByText('components')).toBeInTheDocument()
    expect(screen.getByText('unchanged.ts')).toBeInTheDocument()
  })
})
