import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { SkillSelectorDialog } from './SkillSelectorDialog'
import { useSkillStore } from '@/stores/skill-store'

const mockElectronAPI = window.electronAPI

function SkillDialogHost() {
  const skills = useSkillStore((state) => state.skills)

  return (
    <div data-testid="skill-count">{skills.length}
      <SkillSelectorDialog
        open={true}
        onOpenChange={vi.fn()}
        initialSkillIds={[]}
        onConfirm={vi.fn()}
      />
    </div>
  )
}

describe('SkillSelectorDialog', () => {
  beforeEach(() => {
    useSkillStore.setState({
      skills: [],
      selectedSkillId: null,
      isLoading: false,
      error: null
    })
    vi.clearAllMocks()
  })

  it('does not loop when the parent rerenders with a fresh empty initialSkillIds array', async () => {
    ;(mockElectronAPI.skills.getAll as unknown as Mock).mockResolvedValue([
      {
        id: 'skill-1',
        name: 'Debugging',
        description: 'Trace regressions',
        content: '',
        tags: ['bug'],
        confidence: 0.9,
        uses: 3,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      }
    ])

    render(<SkillDialogHost />)

    await screen.findByText('Debugging')

    await waitFor(() => {
      expect(screen.getByTestId('skill-count')).toHaveTextContent('1')
    })

    expect(mockElectronAPI.skills.getAll).toHaveBeenCalledTimes(1)
  })
})
