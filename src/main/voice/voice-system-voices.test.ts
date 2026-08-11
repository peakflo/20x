import { describe, it, expect } from 'vitest'
import {
  listSystemVoices,
  parseEspeakVoices,
  parseSayVoices,
  parseWindowsVoices,
  pickDefaultSystemVoice,
  systemVoiceId,
  systemVoiceName,
} from './voice-system-voices'

/**
 * The system voice is the half of the design that costs nothing, so its list
 * has to be read correctly on all three systems. The parsers are tested against
 * real output rather than against the machine this runs on.
 */

describe('parseSayVoices', () => {
  const SAY_OUTPUT = [
    'Albert              en_US    # Hello! My name is Albert.',
    'Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.',
    'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
    'Samantha            en_US    # Hello! My name is Samantha.',
    'Majed               ar_001   # مرحبًا! اسمي ماجد.',
    '',
  ].join('\n')

  it('reads a name that holds spaces and brackets', () => {
    const voices = parseSayVoices(SAY_OUTPUT)
    const eddy = voices.find((v) => v.label.startsWith('Eddy'))
    expect(eddy?.label).toBe('Eddy (English (UK))')
    expect(eddy?.language).toBe('en-GB')
    expect(eddy?.id).toBe('system:Eddy (English (UK))')
  })

  it('reads every voice and marks them all as system voices', () => {
    const voices = parseSayVoices(SAY_OUTPUT)
    expect(voices).toHaveLength(5)
    expect(voices.every((v) => v.engine === 'system' && v.speakerId === 0)).toBe(true)
  })

  it('reads a language tag that holds digits', () => {
    const majed = parseSayVoices(SAY_OUTPUT).find((v) => v.label === 'Majed')
    expect(majed?.language).toBe('ar-001')
  })

  it('ignores an empty line', () => {
    expect(parseSayVoices('\n\n')).toEqual([])
  })
})

describe('parseWindowsVoices', () => {
  it('reads the name, the language and the sex', () => {
    const voices = parseWindowsVoices('Microsoft Zira Desktop|en-US|Female\r\nMicrosoft David|en-US|Male\r\n')
    expect(voices).toHaveLength(2)
    expect(voices[0].id).toBe('system:Microsoft Zira Desktop')
    expect(voices[0].language).toBe('en-US')
    expect(voices[0].description).toBe('Female.')
  })

  it('ignores a line with no language', () => {
    expect(parseWindowsVoices('rubbish\n')).toEqual([])
  })
})

describe('parseEspeakVoices', () => {
  it('reads the language and the name', () => {
    const output = [
      'Pty Language       Age/Gender VoiceName          File                 Other Languages',
      ' 5  en-gb          --/M      English (Great Britain)  gmw/en',
      ' 5  en-us          --/M      English (America)        gmw/en-US',
    ].join('\n')
    const voices = parseEspeakVoices(output)
    expect(voices).toHaveLength(2)
    expect(voices[0].id).toBe('system:en-gb')
    expect(voices[0].label).toBe('English (Great Britain)')
  })
})

describe('the chosen voice', () => {
  it('prefers an English voice', () => {
    const voices = parseSayVoices(
      ['Anna                de_DE    # Hallo!', 'Samantha            en_US    # Hello!'].join('\n')
    )
    expect(pickDefaultSystemVoice(voices)?.label).toBe('Samantha')
  })

  it('takes the first voice when none is English', () => {
    const voices = parseSayVoices('Anna                de_DE    # Hallo!')
    expect(pickDefaultSystemVoice(voices)?.label).toBe('Anna')
  })

  it('returns nothing when the system has no voice', () => {
    expect(pickDefaultSystemVoice([])).toBeNull()
  })
})

describe('voice IDs', () => {
  it('round-trips a name', () => {
    expect(systemVoiceName(systemVoiceId('Microsoft Zira Desktop'))).toBe('Microsoft Zira Desktop')
  })

  it('reads nothing out of an ID that is not a system voice', () => {
    expect(systemVoiceName('local:kokoro-en-v0_19:1')).toBe('')
  })
})

describe('listSystemVoices', () => {
  it('reports no voice on a system 20x cannot speak on', async () => {
    await expect(listSystemVoices('aix' as NodeJS.Platform)).resolves.toEqual([])
  })
})
