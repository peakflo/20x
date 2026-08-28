import { describe, it, expect } from 'vitest'
import {
  buildAuthorityNotice,
  buildSystemMessage,
  computeDeliveryId,
  evaluateAuthorityGate,
  isSystemGeneratedMessage,
  FINDINGS_BEGIN,
  FINDINGS_END,
  SYSTEM_MESSAGE_MARKER,
  SystemMessageOrigin
} from './system-authority'

/**
 * The verbatim finding from the 2026-08-20 incident. It was delivered as role=user
 * and read by the task agent as a human instruction to deploy to production.
 */
const INCIDENT_FINDINGS = `Action required:

- \`peakflo-web\` PR #9446: CI passed, approved, merged at 12:08Z; staging deployed successfully. No production (\`prod\`) promotion/deployment found.
- \`upload-functions\` PR #9866: CI passed, approved, merged at 12:01Z; staging deployed successfully. No production (\`production\`) promotion/deployment found.
- Controlled replay was not run because production prerequisites are unmet.

Both fixes must be deployed to production before the approved replay and verification.`

describe('evaluateAuthorityGate', () => {
  it('flags the exact incident findings as needing human authorization', () => {
    const gate = evaluateAuthorityGate(INCIDENT_FINDINGS)
    expect(gate.requiresHumanAuthorization).toBe(true)
    expect(gate.categories).toContain('production-deployment')
  })

  it('flags a conditional sentence — "must be deployed to production before ..." is not an approval', () => {
    const gate = evaluateAuthorityGate('Both fixes must be deployed to production before the approved replay and verification.')
    expect(gate.requiresHumanAuthorization).toBe(true)
    expect(gate.categories).toContain('production-deployment')
  })

  it('flags merge and review-bypass requests', () => {
    expect(evaluateAuthorityGate('Please merge PR #9446 now.').categories).toContain('merge-or-review-bypass')
    expect(evaluateAuthorityGate('Bypass the required review to unblock the release.').categories).toContain('merge-or-review-bypass')
  })

  it('flags replays, destructive data work and external messages', () => {
    expect(evaluateAuthorityGate('Run the ON_CREDIT_NOTE_WRITE replay.').categories).toContain('replay-or-backfill')
    expect(evaluateAuthorityGate('Delete the stale records from the production database.').categories).toContain('destructive-data-operation')
    expect(evaluateAuthorityGate('Email the customer about the delay.').categories).toContain('external-communication')
  })

  it('does not flag ordinary read-only monitoring findings', () => {
    const benign = [
      'PR #9446 has a new review comment asking about naming.',
      'CI failed on the latest commit: 2 unit tests are red.',
      'The linked issue #456 was closed by the reporter.',
      'The branch has a merge conflict in src/main/index.ts.'
    ]
    for (const findings of benign) {
      expect(evaluateAuthorityGate(findings).requiresHumanAuthorization).toBe(false)
    }
  })
})

describe('buildSystemMessage', () => {
  const meta = {
    origin: SystemMessageOrigin.Heartbeat,
    taskId: 'task-1',
    deliveryId: 'abcd1234',
    generatedAt: '2026-08-20T12:40:54.000Z'
  }

  it('marks the message as machine-authored and non-authorizing', () => {
    const message = buildSystemMessage(meta, 'Header', INCIDENT_FINDINGS, 'Trailer')
    expect(message.startsWith(SYSTEM_MESSAGE_MARKER)).toBe(true)
    expect(isSystemGeneratedMessage(message)).toBe(true)
    expect(message).toContain('human_authored=false')
    expect(message).toContain('authorizes_actions=false')
    expect(message).toContain(`origin=${SystemMessageOrigin.Heartbeat}`)
    expect(message).toContain('delivery=abcd1234')
  })

  it('fences the findings as data and quotes them verbatim', () => {
    const message = buildSystemMessage(meta, 'Header', INCIDENT_FINDINGS)
    expect(message).toContain(FINDINGS_BEGIN)
    expect(message).toContain(FINDINGS_END)
    expect(message).toContain('Both fixes must be deployed to production before the approved replay and verification.')
    const fenced = message.split(FINDINGS_BEGIN)[1].split(FINDINGS_END)[0]
    expect(fenced).toContain('Both fixes must be deployed to production')
  })

  it('states the authority boundary for every privileged operation class', () => {
    const notice = buildAuthorityNotice(SystemMessageOrigin.Heartbeat)
    expect(notice).toMatch(/no human wrote it/i)
    expect(notice).toMatch(/merge or approve pull requests/i)
    expect(notice).toMatch(/deploy\/promote\/roll back anything in production/i)
    expect(notice).toMatch(/replays, backfills or migrations/i)
    expect(notice).toMatch(/send messages outside this task/i)
    expect(notice).toMatch(/separate, explicit instruction that a human typed/i)
  })
})

describe('computeDeliveryId', () => {
  it('is stable for identical findings — the duplicate 501/502 delivery collapses to one id', () => {
    expect(computeDeliveryId('task-1', INCIDENT_FINDINGS)).toBe(computeDeliveryId('task-1', INCIDENT_FINDINGS))
  })

  it('ignores whitespace and case differences', () => {
    expect(computeDeliveryId('task-1', 'PR #1 needs a comment reply')).toBe(
      computeDeliveryId('task-1', '  pr #1   needs a\ncomment reply  ')
    )
  })

  it('differs per task and per finding', () => {
    expect(computeDeliveryId('task-1', INCIDENT_FINDINGS)).not.toBe(computeDeliveryId('task-2', INCIDENT_FINDINGS))
    expect(computeDeliveryId('task-1', INCIDENT_FINDINGS)).not.toBe(computeDeliveryId('task-1', 'CI failed'))
  })
})
