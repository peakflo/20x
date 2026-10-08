import { describe, expect, it } from 'vitest'
import { ECHO_MEMORY_MS, SpokenEcho, isNoise, wordsOf } from './voice-echo'

describe('isNoise', () => {
  it('drops what a cough or a breath decodes to', () => {
    expect(isNoise('')).toBe(true)
    expect(isNoise('UH')).toBe(true)
    expect(isNoise('the')).toBe(true)
    expect(isNoise('um, hmm.')).toBe(true)
  })

  it('keeps short real answers', () => {
    expect(isNoise('yes')).toBe(false)
    expect(isNoise('stop')).toBe(false)
    expect(isNoise('no')).toBe(false)
    expect(isNoise('uh open the invoices task')).toBe(false)
  })
})

describe('SpokenEcho', () => {
  it('recognises the answer coming back through the microphone', () => {
    const echo = new SpokenEcho()
    echo.remember('You have three tasks waiting for review.', 1000)
    // The small model writes in capitals, without punctuation, and misses words.
    expect(echo.isEcho('YOU HAVE THREE TASKS WAITING', 2000)).toBe(true)
  })

  it('lets through what the user really says', () => {
    const echo = new SpokenEcho()
    echo.remember('You have three tasks waiting for review.', 1000)
    expect(echo.isEcho('open the first one and start it', 2000)).toBe(false)
  })

  it('never calls a single word an echo', () => {
    const echo = new SpokenEcho()
    echo.remember('Should I stop the agent?', 1000)
    expect(echo.isEcho('stop', 2000)).toBe(false)
  })

  it('forgets what was read a while ago', () => {
    const echo = new SpokenEcho()
    echo.remember('You have three tasks waiting for review.', 1000)
    expect(echo.isEcho('three tasks waiting', 1000 + ECHO_MEMORY_MS + 1)).toBe(false)
  })

  it('ignores filler when matching', () => {
    const echo = new SpokenEcho()
    echo.remember('The build is green.', 1000)
    expect(echo.isEcho('uh the build is green', 1500)).toBe(true)
  })
})

describe('wordsOf', () => {
  it('normalises case and punctuation', () => {
    expect(wordsOf("It's DONE, Peako!")).toEqual(["it's", 'done', 'peako'])
  })
})
