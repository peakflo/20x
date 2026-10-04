import { describe, expect, it } from 'vitest'
import { branchType, generateBranchName, sanitizeBranchName, withBranchSuffix } from './worktree-branch-name'

const task = { id: 'task_abcdef123456', title: 'Fix login redirect!', description: 'Broken after sign in', type: 'coding', labels: ['bug'], created_at: '2026-10-05T00:00:00Z' }

describe('worktree branch names', () => {
  it('keeps the current prefix default and accepts an edited prefix', () => {
    expect(generateBranchName(task, {})).toBe('task/task_abcdef123456')
    expect(generateBranchName(task, { mode: 'prefix', prefix: 'Work / Fixes/' })).toBe('work/fixes/task_abcdef123456')
  })

  it('uses task type and labels for semantic names', () => {
    expect(branchType(task)).toBe('fix')
    expect(generateBranchName(task, { mode: 'type-title' })).toBe('fix/fix-login-redirect-ef123456')
    expect(generateBranchName({ ...task, labels: ['feature'] }, { mode: 'type-title' })).toMatch(/^feat\//)
    expect(generateBranchName({ ...task, labels: [] }, { mode: 'type-title' })).toMatch(/^chore\//)
  })

  it('accepts an AI proposal and falls back without one', () => {
    expect(generateBranchName(task, { mode: 'ai' }, 'fix/login-redirect')).toBe('fix/login-redirect')
    expect(generateBranchName(task, { mode: 'ai' })).toBe(generateBranchName(task, { mode: 'type-title' }))
  })

  it('replaces template placeholders', () => {
    expect(generateBranchName(task, { mode: 'template', template: '{date}/{type}/{slug}-{shortId}-{id}' }))
      .toBe('2026-10-05/fix/fix-login-redirect-ef123456-task_abcdef123456')
  })

  it('sanitizes invalid refs and bounds length', () => {
    const name = sanitizeBranchName('  HEAD//A..B@{bad} / .lock /// Feature 🚀')
    expect(name).toBe('head/a-b-bad/lock/feature')
    expect(sanitizeBranchName('x'.repeat(200)).length).toBeLessThanOrEqual(100)
    expect(withBranchSuffix('x'.repeat(100), 'abc123')).toMatch(/-abc123$/)
  })
})
