import { describe, it, expect } from 'vitest'
import { isAgentConfigured, getAgentConfigIssue } from './agent-utils'

describe('isAgentConfigured', () => {
  it('returns false when agent is null/undefined', () => {
    expect(isAgentConfigured(null)).toBe(false)
    expect(isAgentConfigured(undefined)).toBe(false)
  })

  it('returns false when config is missing', () => {
    expect(isAgentConfigured({})).toBe(false)
    expect(isAgentConfigured({ config: null })).toBe(false)
  })

  it('returns false when coding_agent is missing', () => {
    expect(isAgentConfigured({ config: { model: 'anthropic/claude-3-5' } })).toBe(false)
  })

  it('returns false when model is missing', () => {
    expect(isAgentConfigured({ config: { coding_agent: 'claude_code' } })).toBe(false)
  })

  it('returns false when either field is an empty string', () => {
    expect(isAgentConfigured({ config: { coding_agent: '', model: 'anthropic/claude-3-5' } })).toBe(false)
    expect(isAgentConfigured({ config: { coding_agent: 'claude_code', model: '' } })).toBe(false)
    expect(isAgentConfigured({ config: { coding_agent: '  ', model: 'x' } })).toBe(false)
  })

  it('returns true when both coding_agent and model are set', () => {
    expect(
      isAgentConfigured({ config: { coding_agent: 'claude_code', model: 'anthropic/claude-3-5' } })
    ).toBe(true)
  })

  it('handles unknown-typed config (mobile agent shape)', () => {
    const mobileAgent = { config: { coding_agent: 'opencode', model: 'openai/gpt-4' } as Record<string, unknown> }
    expect(isAgentConfigured(mobileAgent)).toBe(true)
  })
})

describe('getAgentConfigIssue', () => {
  it('returns a message when no agent is supplied', () => {
    expect(getAgentConfigIssue(null)).toBe('No agent selected')
  })

  it('reports both missing', () => {
    expect(getAgentConfigIssue({ config: {} })).toBe('Provider and model are not selected')
  })

  it('reports missing provider', () => {
    expect(getAgentConfigIssue({ config: { model: 'm' } })).toBe('Provider is not selected')
  })

  it('reports missing model', () => {
    expect(getAgentConfigIssue({ config: { coding_agent: 'claude_code' } })).toBe('Model is not selected')
  })

  it('returns null when fully configured', () => {
    expect(
      getAgentConfigIssue({ config: { coding_agent: 'claude_code', model: 'anthropic/claude-3-5' } })
    ).toBeNull()
  })
})
