import { describe, expect, it } from 'vitest'
import { ArtifactType, type Artifact } from '@shared/artifacts'
import { containsArtifactTarget, findMessageArtifact } from './find-message-artifact'

function prArtifact(url: string, id = url): Artifact {
  return {
    id,
    taskId: 'task-1',
    type: ArtifactType.PR,
    title: `Pull request ${url.split('/').pop()}`,
    url,
    updatedAt: 1,
    reloadTrigger: 0
  }
}

describe('containsArtifactTarget', () => {
  it('matches an exact GitHub pull URL', () => {
    expect(containsArtifactTarget(
      'Created https://github.com/peakflo/peakflo-web/pull/9977',
      'https://github.com/peakflo/peakflo-web/pull/9977'
    )).toBe(true)
  })

  it('does not let /pull/997 match inside /pull/9977', () => {
    expect(containsArtifactTarget(
      'Created https://github.com/peakflo/peakflo-web/pull/9977',
      'https://github.com/peakflo/peakflo-web/pull/997'
    )).toBe(false)
  })

  it('does not let #997 match inside #9977', () => {
    expect(containsArtifactTarget('See #9977 for the cherry-pick', '#997')).toBe(false)
    expect(containsArtifactTarget('See #9977 for the cherry-pick', '#9977')).toBe(true)
  })

  it('still matches a standalone shorter PR number', () => {
    expect(containsArtifactTarget(
      'Opened https://github.com/peakflo/peakflo-web/pull/997 last year',
      'https://github.com/peakflo/peakflo-web/pull/997'
    )).toBe(true)
    expect(containsArtifactTarget('See #997 for history', '#997')).toBe(true)
  })

  it('does not let /pull/1058 match inside /pull/10585', () => {
    expect(containsArtifactTarget(
      'https://github.com/peakflo/upload-functions/pull/10585',
      'https://github.com/peakflo/upload-functions/pull/1058'
    )).toBe(false)
  })
})

describe('findMessageArtifact', () => {
  const olderPr = prArtifact('https://github.com/peakflo/peakflo-web/pull/997', 'pr-997')
  const newerPr = prArtifact('https://github.com/peakflo/peakflo-web/pull/9977', 'pr-9977')
  const olderUf = prArtifact('https://github.com/peakflo/upload-functions/pull/1058', 'pr-1058')
  const newerUf = prArtifact('https://github.com/peakflo/upload-functions/pull/10585', 'pr-10585')

  it('prefers the longer PR URL when a shorter prefix artifact exists first', () => {
    const message = {
      content: 'Ship the cherry-pick',
      tool: {
        name: 'Bash',
        status: 'success',
        title: 'Bash',
        output: 'Created https://github.com/peakflo/peakflo-web/pull/9977'
      }
    }
    // Shorter artifact is listed first — the old includes() matcher returned it.
    expect(findMessageArtifact(message, [olderPr, newerPr])?.url).toBe(newerPr.url)
  })

  it('does not attach a shorter-only PR artifact to a longer PR message', () => {
    const message = {
      tool: {
        name: 'Bash',
        status: 'success',
        output: 'https://github.com/peakflo/peakflo-web/pull/9977\nAlso mentioned as #9977'
      }
    }
    expect(findMessageArtifact(message, [olderPr])).toBeUndefined()
  })

  it('still matches the exact shorter PR when that is what the tool produced', () => {
    const message = {
      tool: {
        name: 'Bash',
        status: 'success',
        output: 'Created https://github.com/peakflo/peakflo-web/pull/997'
      }
    }
    expect(findMessageArtifact(message, [olderPr, newerPr])?.url).toBe(olderPr.url)
  })

  it('handles 1058 vs 10585 the same way', () => {
    const message = {
      tool: {
        name: 'Bash',
        status: 'success',
        output: 'Created https://github.com/peakflo/upload-functions/pull/10585'
      }
    }
    expect(findMessageArtifact(message, [olderUf, newerUf])?.url).toBe(newerUf.url)
    expect(findMessageArtifact(message, [olderUf])).toBeUndefined()
  })

  it('prefers an exact URL extracted from a create_pr tool over substring order', () => {
    const message = {
      tool: {
        name: 'create_pull_request',
        status: 'completed',
        output: JSON.stringify({
          html_url: 'https://github.com/peakflo/peakflo-web/pull/9977',
          number: 9977
        })
      }
    }
    expect(findMessageArtifact(message, [olderPr, newerPr])?.url).toBe(newerPr.url)
  })

  it('ignores non-success tool calls', () => {
    const message = {
      tool: {
        name: 'Bash',
        status: 'error',
        output: 'Created https://github.com/peakflo/peakflo-web/pull/9977'
      }
    }
    expect(findMessageArtifact(message, [newerPr])).toBeUndefined()
  })
})
