import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { RepoSelectorDialog } from './RepoSelectorDialog'

const mockElectronAPI = window.electronAPI

describe('RepoSelectorDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(mockElectronAPI.github.checkCli as unknown as Mock).mockResolvedValue({
      installed: true,
      authenticated: true,
      username: 'dmitry'
    })
    ;(mockElectronAPI.github.fetchOrgs as unknown as Mock).mockResolvedValue(['peakflo', 'other-org'])
    ;(mockElectronAPI.github.fetchOrgRepos as unknown as Mock).mockImplementation(async (org: string) => {
      if (org === 'other-org') {
        return [
          {
            name: 'other-repo',
            fullName: 'other-org/other-repo',
            defaultBranch: 'main',
            cloneUrl: 'https://github.com/other-org/other-repo.git',
            description: 'Other org repo',
            isPrivate: false
          }
        ]
      }

      return [
        {
          name: 'core',
          fullName: 'peakflo/core',
          defaultBranch: 'main',
          cloneUrl: 'https://github.com/peakflo/core.git',
          description: 'Main repo',
          isPrivate: false
        }
      ]
    })
  })

  it('switches organization from header and confirms repos for selected org', async () => {
    const onConfirm = vi.fn()

    render(
      <RepoSelectorDialog
        open={true}
        onOpenChange={vi.fn()}
        org="peakflo"
        initialRepos={[]}
        onConfirm={onConfirm}
      />
    )

    await waitFor(() => {
      expect(mockElectronAPI.github.fetchOrgRepos).toHaveBeenCalledWith('peakflo')
    })

    const orgSelect = screen.getByLabelText('Organization') as HTMLSelectElement
    fireEvent.change(orgSelect, { target: { value: 'github:other-org' } })

    await waitFor(() => {
      expect(mockElectronAPI.github.fetchOrgRepos).toHaveBeenCalledWith('other-org')
    })

    fireEvent.click(await screen.findByText('other-repo'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(onConfirm).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ fullName: 'other-org/other-repo' })
      ]),
      'other-org',
      'github'
    )
  })
})
