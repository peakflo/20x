import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SkillList } from './SkillList'
import type { Skill } from '@/types'

afterEach(cleanup)

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-1',
    name: 'test-skill',
    description: 'A test skill',
    content: '# Test',
    version: 1,
    confidence: 0.95,
    uses: 5,
    last_used: '2026-03-10T00:00:00Z',
    tags: ['testing', 'vitest'],
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-10T00:00:00Z',
    ...overrides
  }
}

describe('SkillList', () => {
  it('renders empty state when no skills', () => {
    render(<SkillList skills={[]} selectedSkillId={null} onSelectSkill={vi.fn()} />)
    expect(screen.getByText('No skills yet. Create one to get started.')).toBeDefined()
  })

  it('renders custom empty message', () => {
    render(
      <SkillList
        skills={[]}
        selectedSkillId={null}
        onSelectSkill={vi.fn()}
        emptyMessage="No matching skills"
      />
    )
    expect(screen.getByText('No matching skills')).toBeDefined()
  })

  it('renders skill list items', () => {
    const skills = [
      makeSkill({ id: 'skill-1', name: 'code-review', description: 'Reviews code changes' }),
      makeSkill({ id: 'skill-2', name: 'deploy-helper', description: 'Helps with deploys' })
    ]
    render(<SkillList skills={skills} selectedSkillId={null} onSelectSkill={vi.fn()} />)
    expect(screen.getByText('code-review')).toBeDefined()
    expect(screen.getByText('deploy-helper')).toBeDefined()
    expect(screen.getByText('Reviews code changes')).toBeDefined()
    expect(screen.getByText('Helps with deploys')).toBeDefined()
  })

  it('highlights selected skill', () => {
    const skills = [
      makeSkill({ id: 'skill-1', name: 'alpha-skill' }),
      makeSkill({ id: 'skill-2', name: 'beta-skill' })
    ]
    render(<SkillList skills={skills} selectedSkillId="skill-1" onSelectSkill={vi.fn()} />)
    const selectedButton = screen.getByText('alpha-skill').closest('button')
    // Selected skill has 'bg-accent' as a direct class (not just hover:bg-accent/50)
    expect(selectedButton?.className).toMatch(/(?<![:\w])bg-accent(?!\/)/)
  })

  it('calls onSelectSkill when clicking a skill', () => {
    const onSelectSkill = vi.fn()
    const skills = [makeSkill({ id: 'skill-42', name: 'gamma-skill' })]
    render(<SkillList skills={skills} selectedSkillId={null} onSelectSkill={onSelectSkill} />)
    screen.getByText('gamma-skill').closest('button')?.click()
    expect(onSelectSkill).toHaveBeenCalledWith('skill-42')
  })
})
