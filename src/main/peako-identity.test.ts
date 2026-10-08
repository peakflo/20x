import { describe, expect, it } from 'vitest'
import { peakoIdentityPrompt, withPeakoIdentity } from './peako-identity'

describe('Peako identity', () => {
  it('tells the Mastermind session its name and keeps the agent prompt after it', () => {
    const prompt = withPeakoIdentity('mastermind-session', 'Prefer TypeScript.', 'Nova')
    expect(prompt?.startsWith('You are Nova, the assistant built into 20x')).toBe(true)
    expect(prompt?.endsWith('Prefer TypeScript.')).toBe(true)
  })

  it('falls back to Peako when no name is set', () => {
    expect(withPeakoIdentity('mastermind-session', undefined, undefined)).toContain('You are Peako')
  })

  it('leaves every other session untouched', () => {
    expect(withPeakoIdentity('task-1', 'Prefer TypeScript.', 'Nova')).toBe('Prefer TypeScript.')
    expect(withPeakoIdentity('heartbeat-1', undefined, 'Nova')).toBeUndefined()
  })

  it('is the same text every time, so the prompt stays cacheable', () => {
    expect(peakoIdentityPrompt('Peako')).toBe(peakoIdentityPrompt('Peako'))
  })

  it('asks for short, speakable answers and tool checks before status answers', () => {
    const prompt = peakoIdentityPrompt('Peako')
    expect(prompt).toContain('read aloud')
    expect(prompt).toContain('call your tools first')
  })
})
