import { describe, it, expect } from 'vitest'
import {
  VOICE_TTS_HARD_MAX_CHARS,
  clampSpeechSpeed,
  isVoiceTtsEngineId,
  splitIntoSentences,
  splitStreamingSentences,
  toSpokenText,
  withShortLeadIn,
} from './voice-tts'

/**
 * The rules in design §5.7 about what may be heard are enforced here, in one
 * pure function, so they can be checked without a model and without a speaker.
 */

describe('toSpokenText', () => {
  it('names a code block instead of reading it', () => {
    const result = toSpokenText('Here is the fix:\n\n```ts\nconst a = 1\nconst b = 2\n```\n\nIt works.')
    expect(result.text).toContain('A code block of 2 lines is in the message.')
    expect(result.text).not.toContain('const a = 1')
    expect(result.codeBlocks).toBe(1)
  })

  it('names a single line of code in the singular', () => {
    expect(toSpokenText('```\nnpm test\n```').text).toBe('One line of code is in the message.')
  })

  it('closes an unterminated code block', () => {
    const result = toSpokenText('Run this:\n```bash\nnpm test\nnpm run build')
    expect(result.text).toContain('A code block of 2 lines is in the message.')
    expect(result.text).not.toContain('npm test')
  })

  it('names a table once, not row by row', () => {
    const result = toSpokenText('| a | b |\n| - | - |\n| 1 | 2 |\nDone.')
    expect(result.text).toBe('A table is in the message.\nDone.')
  })

  it('reads a link label and never the address', () => {
    const result = toSpokenText('See [the pull request](https://github.com/peakflo/20x/pull/452).')
    expect(result.text).toBe('See the pull request.')
  })

  it('replaces a bare address', () => {
    expect(toSpokenText('Open https://example.com/x?y=1 now.').text).toBe('Open a link now.')
  })

  it('replaces a file path', () => {
    expect(toSpokenText('Edit src/main/voice/voice-tts-worker.js first.').text).toBe(
      'Edit a file path first.'
    )
    expect(toSpokenText('Edit /Users/me/notes/todo.md first.').text).toBe('Edit a file path first.')
  })

  it('strips heading, list, quote and emphasis marks', () => {
    const result = toSpokenText('## Result\n\n- **one** item\n- *two* items\n\n> a quote')
    expect(result.text).toBe('Result\n\none item\ntwo items\n\na quote')
  })

  it('keeps the words inside inline code', () => {
    expect(toSpokenText('The `taskId` is missing.').text).toBe('The taskId is missing.')
  })

  it('stops at the character limit, at the end of a sentence', () => {
    const long = `${'This is one sentence. '.repeat(40)}`
    const result = toSpokenText(long, 120)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(120)
    expect(result.text.endsWith('.')).toBe(true)
  })

  it('never goes above the hard limit, whatever the setting says', () => {
    const result = toSpokenText('word '.repeat(4000), 999_999)
    expect(result.text.length).toBeLessThanOrEqual(VOICE_TTS_HARD_MAX_CHARS)
  })

  it('returns nothing for an empty answer', () => {
    expect(toSpokenText('   ').text).toBe('')
    expect(toSpokenText('').text).toBe('')
  })
})

describe('splitIntoSentences', () => {
  it('splits on sentence punctuation and keeps it', () => {
    expect(splitIntoSentences('Task created. It is running! Is it done?')).toEqual([
      'Task created.',
      'It is running!',
      'Is it done?',
    ])
  })

  it('splits on a blank line', () => {
    expect(splitIntoSentences('One\n\nTwo')).toEqual(['One', 'Two'])
  })

  it('breaks a very long sentence so playback is not held up', () => {
    const long = `${'a'.repeat(100)}, ${'b'.repeat(100)}, ${'c'.repeat(100)}`
    const parts = splitIntoSentences(long, 120)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(120)
    expect(parts.join(' ').replace(/\s+/g, '')).toBe(long.replace(/\s+/g, ''))
  })

  it('returns an empty list for empty text', () => {
    expect(splitIntoSentences('')).toEqual([])
    expect(splitIntoSentences('   ')).toEqual([])
  })
})

describe('guards', () => {
  it('accepts only the two known engines', () => {
    expect(isVoiceTtsEngineId('system')).toBe(true)
    expect(isVoiceTtsEngineId('local')).toBe(true)
    expect(isVoiceTtsEngineId('openai')).toBe(false)
    expect(isVoiceTtsEngineId(null)).toBe(false)
  })

  it('keeps the speed inside a range a listener can follow', () => {
    expect(clampSpeechSpeed(1)).toBe(1)
    expect(clampSpeechSpeed(9)).toBe(2)
    expect(clampSpeechSpeed(0.1)).toBe(0.5)
    expect(clampSpeechSpeed(Number.NaN)).toBe(1)
  })
})

describe('splitStreamingSentences', () => {
  /**
   * An answer arrives a few words at a time and speech must start before the
   * last word does. The risk is reading a sentence that is not finished:
   * "The test failed" and "The test failed to start" are read very differently,
   * and the difference is one word that has not arrived yet.
   */
  it('holds back a sentence that is still being written', () => {
    const result = splitStreamingSentences('It passed. The test failed')
    expect(result.sentences).toEqual(['It passed.'])
    expect(result.remainder).toBe('The test failed')
  })

  it('releases a sentence the moment it is finished', () => {
    const result = splitStreamingSentences('It passed. The test failed to start.')
    expect(result.sentences).toEqual(['It passed.', 'The test failed to start.'])
    expect(result.remainder).toBe('')
  })

  it('releases the tail when nothing more is coming', () => {
    const result = splitStreamingSentences('It passed. And that is all', true)
    expect(result.sentences).toEqual(['It passed.', 'And that is all'])
    expect(result.remainder).toBe('')
  })

  it('says nothing at all from a first half-word', () => {
    expect(splitStreamingSentences('The').sentences).toEqual([])
    expect(splitStreamingSentences('').sentences).toEqual([])
  })

  it('treats a closing quotation mark as part of the full stop', () => {
    expect(splitStreamingSentences('He said "no."').sentences).toEqual(['He said "no."'])
  })
})

describe('withShortLeadIn', () => {
  /**
   * A sentence is produced whole before any of it can be heard, so the opening
   * one sets the wait before an answer starts. Measured on the natural voice:
   * a 119-character opening took 5.4 s to first sound, a 55-character one 2.9 s.
   */
  it('breaks a long opening at a clause when there is one in reach', () => {
    const long = 'The login test failed, and the retry after it did not help either at all.'
    const [first, second] = withShortLeadIn([long])

    expect(first).toBe('The login test failed,')
    expect(`${first} ${second}`).toBe(long)
  })

  it('breaks at a word when the clause is out of reach', () => {
    const long =
      'The login test failed because the session token expired before the request was sent, and the retry did not help.'
    const [first, second] = withShortLeadIn([long])

    // The comma sits past the limit, so waiting for it would defeat the point.
    expect(first.length).toBeLessThanOrEqual(61)
    expect(`${first} ${second}`).toBe(long)
  })

  it('leaves a short opening alone', () => {
    expect(withShortLeadIn(['It passed.', 'Nothing else.'])).toEqual(['It passed.', 'Nothing else.'])
  })

  it('touches only the opening, because every later sentence is free', () => {
    const long = 'A short one. ' + 'x'.repeat(200)
    const sentences = ['A short one.', 'x'.repeat(200)]
    expect(withShortLeadIn(sentences)).toEqual(sentences)
    expect(long.length).toBeGreaterThan(0)
  })

  it('falls back to a word boundary when there is no clause', () => {
    const long = 'The build finished and every one of the tests in the suite has now passed correctly'
    const [first] = withShortLeadIn(long ? [long] : [])
    expect(first.length).toBeLessThan(long.length)
    expect(long.startsWith(first)).toBe(true)
  })

  it('gives up rather than cut a word in half', () => {
    const unbreakable = ['x'.repeat(200)]
    expect(withShortLeadIn(unbreakable)).toEqual(unbreakable)
  })

  it('copes with nothing to say', () => {
    expect(withShortLeadIn([])).toEqual([])
  })
})
