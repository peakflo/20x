import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

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
  changes.mockReset().mockResolvedValue([{ repo: 'peakflo/20x', diff, branch: 'feature/changes', pushed: true }])
})

afterEach(cleanup)

describe('ChangesPanel', () => {
  it('browses a changed-file hierarchy and switches to the continuous diff', async () => {
    render(<ChangesPanel taskId="task-1" repos={['peakflo/20x']} />)

    expect(await screen.findByText('components')).toBeInTheDocument()
    expect(screen.getByText('Button.tsx')).toBeInTheDocument()
    expect(screen.getByText('new.ts')).toBeInTheDocument()
    expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument()
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('−1').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('new.ts').closest('button')!)
    expect(screen.getByText('src/new.ts')).toBeInTheDocument()
    expect(screen.getByText('Added')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Diff' }))
    expect(screen.queryByText('components')).not.toBeInTheDocument()
    expect(screen.getByText('src/components/Button.tsx')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All files' }))
    expect(screen.getByText('components')).toBeInTheDocument()
  })
})
