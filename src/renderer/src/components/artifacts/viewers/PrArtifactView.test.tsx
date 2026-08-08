import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  ArtifactType,
  PullRequestCheckState,
  PullRequestReviewDecision,
  PullRequestState,
  type Artifact,
  type PullRequestDetails
} from '@shared/artifacts'
import { PrArtifactView } from './PrArtifactView'

const artifact: Artifact = {
  id: 'pr-445',
  taskId: 'task-1',
  type: ArtifactType.PR,
  title: 'Pull request 445',
  url: 'https://github.com/peakflo/20x/pull/445',
  updatedAt: 1,
  reloadTrigger: 0
}

const details: PullRequestDetails = {
  url: artifact.url!,
  repository: 'peakflo/20x',
  number: 445,
  title: 'Task artifacts',
  body: 'Adds detailed artifact previews.',
  state: PullRequestState.OPEN,
  isDraft: false,
  reviewDecision: PullRequestReviewDecision.APPROVED,
  author: { login: 'octocat' },
  baseRefName: 'main',
  headRefName: 'feature/artifacts',
  additions: 120,
  deletions: 15,
  changedFiles: 8,
  commentsCount: 3,
  reviewsCount: 2,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-06T00:00:00Z',
  checks: [
    { name: 'verify', state: PullRequestCheckState.PASSED },
    { name: 'deploy', state: PullRequestCheckState.PENDING }
  ]
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      github: { fetchPullRequestDetails: vi.fn().mockResolvedValue(details) },
      shell: { openExternal: vi.fn() }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PrArtifactView', () => {
  it('renders PR metadata, review status, diff stats, and checks', async () => {
    render(<PrArtifactView artifact={artifact} />)

    expect(await screen.findByText('Task artifacts')).toBeInTheDocument()
    expect(screen.getByText('peakflo/20x #445')).toBeInTheDocument()
    expect(screen.getByText('Open', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('Approved')).toBeInTheDocument()
    expect(screen.getByText('+120')).toBeInTheDocument()
    expect(screen.getByText('−15')).toBeInTheDocument()
    expect(screen.getByText('verify')).toBeInTheDocument()
    expect(screen.getByText('1 passed')).toBeInTheDocument()
    expect(screen.getByText('1 pending')).toBeInTheDocument()
  })

  it('keeps the current PR visible during a background refresh', async () => {
    const fetchDetails = window.electronAPI.github.fetchPullRequestDetails as ReturnType<typeof vi.fn>
    const { rerender } = render(<PrArtifactView artifact={artifact} refreshTrigger={0} />)
    expect(await screen.findByText('Task artifacts')).toBeInTheDocument()

    let resolveRefresh: (value: PullRequestDetails) => void = () => undefined
    fetchDetails.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve }))
    rerender(<PrArtifactView artifact={artifact} refreshTrigger={1} />)

    expect(screen.getByText('Task artifacts')).toBeInTheDocument()
    expect(screen.queryByText('Loading pull request…')).not.toBeInTheDocument()

    act(() => resolveRefresh({ ...details, title: 'Updated task artifacts', commentsCount: 4 }))
    expect(await screen.findByText('Updated task artifacts')).toBeInTheDocument()
  })
})
