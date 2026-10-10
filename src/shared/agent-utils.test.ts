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

  it('returns false for an ACP agent with no instance selected, even with no model either', () => {
    // Regression: a freshly added ACP agent (e.g. a registry agent with no
    // declared custom models) has neither a model nor an instance yet — the
    // real blocker is the missing instance, not the model.
    expect(isAgentConfigured({ config: { coding_agent: 'acp' } })).toBe(false)
    expect(isAgentConfigured({ config: { coding_agent: 'acp', acp_instance_id: '' } })).toBe(false)
  })

  it('returns true for an ACP agent with an instance selected but no model', () => {
    // Regression: the ACP adapter starts a session fine with no model set
    // (the agent uses its own default) — requiring one blocked every ACP
    // agent that doesn't declare custom models from ever starting.
    expect(isAgentConfigured({ config: { coding_agent: 'acp', acp_instance_id: 'inst-1' } })).toBe(true)
  })

  it('still honors an explicitly set model on an ACP agent (not required, but not ignored)', () => {
    expect(
      isAgentConfigured({ config: { coding_agent: 'acp', acp_instance_id: 'inst-1', model: 'grok-4' } })
    ).toBe(true)
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

  it('reports a missing ACP instance, not a missing model, for an ACP agent', () => {
    expect(getAgentConfigIssue({ config: { coding_agent: 'acp' } })).toBe('ACP agent instance is not selected')
  })

  it('returns null for an ACP agent with an instance but no model', () => {
    expect(getAgentConfigIssue({ config: { coding_agent: 'acp', acp_instance_id: 'inst-1' } })).toBeNull()
  })
})
