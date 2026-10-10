/**
 * Small bundled snapshot of the public rate table, covering only the model
 * families 20x commonly sees (current Claude, GPT/Codex and Gemini). Used
 * before the first successful fetch and whenever the network is unavailable,
 * so Codex and other non-reporting harnesses still get an estimate on a fresh
 * install. Shaped exactly like the real source file (see `usage-pricing.ts`)
 * so `parseRateTable` handles both the same way.
 *
 * Values are USD per token, taken from the public rate table at the time this
 * snapshot was written. They are not kept in sync automatically — the live
 * fetch supersedes this the moment it succeeds.
 */
export const BUNDLED_RATE_TABLE_RAW: Record<string, Record<string, unknown>> = {
  'claude-sonnet-4-5': {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    litellm_provider: 'anthropic'
  },
  'claude-opus-4-5': {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    litellm_provider: 'anthropic'
  },
  'claude-haiku-4-5': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
    litellm_provider: 'anthropic'
  },
  'gpt-5': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
    input_cost_per_token_priority: 2.5e-6,
    output_cost_per_token_priority: 2e-5,
    cache_read_input_token_cost_priority: 2.5e-7,
    litellm_provider: 'openai'
  },
  'gpt-5-codex': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
    litellm_provider: 'openai'
  },
  'gpt-5.1': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
    litellm_provider: 'openai'
  },
  'gpt-5.1-codex': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
    litellm_provider: 'openai'
  },
  'gpt-4o': {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-6,
    litellm_provider: 'openai'
  },
  o1: {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 6e-5,
    cache_read_input_token_cost: 7.5e-6,
    litellm_provider: 'openai'
  },
  'gemini-2.5-pro': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
    litellm_provider: 'vertex_ai-language-models'
  },
  'gemini-2.5-flash': {
    input_cost_per_token: 3e-7,
    output_cost_per_token: 2.5e-6,
    cache_read_input_token_cost: 3e-8,
    litellm_provider: 'vertex_ai-language-models'
  }
}
