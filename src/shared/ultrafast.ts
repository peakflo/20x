export type SpeedMode = 'ultrafast'

/** Only models advertised for the faster inference tiers can opt in. */
export function supportsUltrafast(harness: string | undefined, model: string | undefined): boolean {
  if (harness === 'claude-code') {
    return model === 'claude-opus-5-5' || model === 'claude-opus-5' || model === 'claude-opus-4-8'
  }
  if (harness === 'codex') {
    return model === 'gpt-6-astra' || model === 'gpt-6.1-sol'
  }
  return false
}
