import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { GitHubManager } from './github-manager'

const PR_VIEW = {
  state: 'OPEN',
  isDraft: false,
  headRefOid: 'abcdef1234567890',
  mergeStateStatus: 'DIRTY',
  reviewDecision: 'CHANGES_REQUESTED',
  url: 'https://github.com/acme/app/pull/42',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'build',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/acme/app/actions/runs/1/job/10',
      startedAt: '2026-10-05T10:00:00Z'
    },
    {
      __typename: 'CheckRun',
      name: 'test',
      status: 'IN_PROGRESS',
      conclusion: '',
      detailsUrl: 'https://github.com/acme/app/actions/runs/1/job/11',
      startedAt: '2026-10-05T10:00:00Z'
    },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING', targetUrl: 'https://ci/legacy' },
    { __typename: 'StatusContext', context: 'ci/legacy-2', state: 'SUCCESS', targetUrl: '' }
  ]
}

const REVIEW_COMMENTS = [
  {
    id: 901,
    body: 'Rename this',
    path: 'src/a.ts',
    line: 7,
    user: { login: 'dmitry', type: 'User' },
    author_association: 'OWNER',
    html_url: 'https://github.com/acme/app/pull/42#discussion_r901'
  },
  {
    id: 902,
    body: 'Drive-by from outside',
    path: 'src/b.ts',
    original_line: 3,
    user: { login: 'stranger', type: 'User' },
    author_association: 'NONE',
    html_url: 'https://github.com/acme/app/pull/42#discussion_r902'
  }
]

const ISSUE_COMMENTS = [
  {
    id: 301,
    body: 'Automated coverage report <!-- codecov -->',
    user: { login: 'codecov[bot]', type: 'Bot' },
    author_association: 'NONE',
    html_url: 'https://github.com/acme/app/pull/42#issuecomment-301'
  },
  {
    id: 302,
    body: 'Done. <!-- 20x:agent -->',
    user: { login: 'dmitry', type: 'User' },
    author_association: 'OWNER',
    html_url: 'https://github.com/acme/app/pull/42#issuecomment-302'
  }
]

const REVIEWS = [
  { id: 501, state: 'CHANGES_REQUESTED', body: '', user: { login: 'dmitry', type: 'User' }, author_association: 'OWNER', html_url: 'https://github.com/acme/app/pull/42#pullrequestreview-501' },
  { id: 502, state: 'APPROVED', body: 'lgtm', user: { login: 'dmitry', type: 'User' }, author_association: 'OWNER' },
  { id: 503, state: 'COMMENTED', body: '   ', user: { login: 'dmitry', type: 'User' }, author_association: 'OWNER' },
  { id: 504, state: 'COMMENTED', body: 'Consider a test', user: { login: 'lead', type: 'User' }, author_association: 'COLLABORATOR' }
]

function fakeGh(responses: Record<string, string> = {}) {
  const calls: string[][] = []
  const runner = vi.fn(async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'pr') return JSON.stringify(PR_VIEW)
    const path = args[args.length - 1]
    if (responses[path] !== undefined) return responses[path]
    if (path.includes('/pulls/42/comments')) return JSON.stringify(REVIEW_COMMENTS)
    if (path.includes('/issues/42/comments')) return JSON.stringify(ISSUE_COMMENTS)
    if (path.includes('/pulls/42/reviews')) return JSON.stringify(REVIEWS)
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  })
  return { runner, calls }
}

describe('GitHubManager.fetchPullRequestWatchSnapshot', () => {
  it('reads the PR, its checks, and the three comment collections', async () => {
    const { runner, calls } = fakeGh()
    const manager = new GitHubManager(runner)
    await manager.fetchPullRequestWatchSnapshot('https://github.com/acme/app/pull/42/files')

    expect(calls[0]).toEqual([
      'pr', 'view', 'https://github.com/acme/app/pull/42',
      '--json', 'state,isDraft,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup,url'
    ])
    expect(calls.slice(1).map((args) => args.at(-1))).toEqual(expect.arrayContaining([
      '/repos/acme/app/pulls/42/comments?per_page=100',
      '/repos/acme/app/issues/42/comments?per_page=100',
      '/repos/acme/app/pulls/42/reviews?per_page=100'
    ]))
    expect(calls.slice(1).every((args) => args.includes('--paginate'))).toBe(true)
  })

  it('maps the PR state, head commit, merge state and review decision', async () => {
    const snapshot = await new GitHubManager(fakeGh().runner).fetchPullRequestWatchSnapshot('https://github.com/acme/app/pull/42')
    expect(snapshot).toMatchObject({
      url: 'https://github.com/acme/app/pull/42',
      state: 'OPEN',
      isDraft: false,
      headSha: 'abcdef1234567890',
      mergeStateStatus: 'DIRTY',
      reviewDecision: 'CHANGES_REQUESTED'
    })
  })

  it('maps check runs by their run identity and commit statuses by their state', async () => {
    const { checks } = await new GitHubManager(fakeGh().runner).fetchPullRequestWatchSnapshot('https://github.com/acme/app/pull/42')
    expect(checks).toEqual([
      {
        name: 'build',
        completed: true,
        conclusion: 'FAILURE',
        runId: 'https://github.com/acme/app/actions/runs/1/job/10',
        url: 'https://github.com/acme/app/actions/runs/1/job/10'
      },
      {
        name: 'test',
        completed: false,
        conclusion: '',
        runId: 'https://github.com/acme/app/actions/runs/1/job/11',
        url: 'https://github.com/acme/app/actions/runs/1/job/11'
      },
      { name: 'ci/legacy', completed: false, conclusion: 'PENDING', runId: 'https://ci/legacy', url: 'https://ci/legacy' },
      { name: 'ci/legacy-2', completed: true, conclusion: 'SUCCESS', runId: '', url: undefined }
    ])
  })

  it('keeps the author association and bot flag, so the watcher can apply the trust rules', async () => {
    const { comments } = await new GitHubManager(fakeGh().runner).fetchPullRequestWatchSnapshot('https://github.com/acme/app/pull/42')
    const byId = Object.fromEntries(comments.map((c) => [`${c.kind}:${c.id}`, c]))

    expect(byId['review_comment:901']).toMatchObject({ author: 'dmitry', authorAssociation: 'OWNER', isBot: false, path: 'src/a.ts', line: 7 })
    expect(byId['review_comment:902']).toMatchObject({ author: 'stranger', authorAssociation: 'NONE', line: 3 })
    expect(byId['issue_comment:301']).toMatchObject({ author: 'codecov[bot]', isBot: true })
    expect(byId['issue_comment:302']).toMatchObject({ body: 'Done. <!-- 20x:agent -->', isBot: false })
  })

  it('keeps only reviews that ask for something or say something', async () => {
    const { comments } = await new GitHubManager(fakeGh().runner).fetchPullRequestWatchSnapshot('https://github.com/acme/app/pull/42')
    const reviews = comments.filter((c) => c.kind === 'review')
    expect(reviews.map((r) => r.id)).toEqual(['501', '504'])
    expect(reviews[0].body).toBe('Changes requested.')
    expect(reviews[1]).toMatchObject({ author: 'lead', authorAssociation: 'COLLABORATOR', body: 'Consider a test' })
  })

  it('does not drop the signed-in user’s own comments, since the user is usually the human reviewer', async () => {
    // No viewer lookup happens, so there is no call that could fail and silently hide comments.
    const { runner, calls } = fakeGh()
    const { comments } = await new GitHubManager(runner).fetchPullRequestWatchSnapshot('https://github.com/acme/app/pull/42')
    expect(calls.some((args) => args.join(' ').includes('api user'))).toBe(false)
    expect(comments.some((c) => c.author === 'dmitry' && c.kind === 'review_comment')).toBe(true)
  })

  it('rejects URLs that are not pull requests without calling gh', async () => {
    const { runner } = fakeGh()
    await expect(new GitHubManager(runner).fetchPullRequestWatchSnapshot('https://github.com/acme/app/issues/1'))
      .rejects.toThrow('A valid GitHub pull request URL is required')
    expect(runner).not.toHaveBeenCalled()
  })

  it('lets gh failures reach the watcher, so it can back off', async () => {
    const runner = vi.fn(async () => { throw new Error('HTTP 403: API rate limit exceeded') })
    await expect(new GitHubManager(runner).fetchPullRequestWatchSnapshot('https://github.com/acme/app/pull/42'))
      .rejects.toThrow('rate limit')
  })
})
