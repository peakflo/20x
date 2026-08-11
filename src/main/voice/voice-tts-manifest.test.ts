import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TTS_SPEAKER_BY_MODEL,
  DEFAULT_VOICE_TTS_MODEL_ID,
  VOICE_TTS_MODEL_MANIFEST,
  findTtsManifestEntry,
  isTtsManifestVerified,
} from './voice-tts-manifest'

/**
 * The catalogue is the one place where a download and a licence become real, so
 * it is checked as data rather than trusted as a document (design §5.10).
 */

describe('the speech-synthesis catalogue', () => {
  it('records a real checksum for every voice', () => {
    for (const entry of VOICE_TTS_MODEL_MANIFEST) {
      expect(entry.archive.sha256, entry.id).toMatch(/^[a-f0-9]{64}$/)
      expect(isTtsManifestVerified(entry), entry.id).toBe(true)
    }
  })

  it('pins every archive to a published release, never to a branch', () => {
    for (const entry of VOICE_TTS_MODEL_MANIFEST) {
      expect(entry.archive.url, entry.id).toContain('/releases/download/')
      expect(entry.archive.sizeBytes, entry.id).toBeGreaterThan(0)
      expect(entry.archive.unpackedBytes, entry.id).toBeGreaterThan(entry.archive.sizeBytes)
    }
  })

  it('states a licence and a licence address for every voice', () => {
    for (const entry of VOICE_TTS_MODEL_MANIFEST) {
      expect(entry.license, entry.id).toBeTruthy()
      expect(entry.licenseUrl, entry.id).toMatch(/^https:\/\//)
    }
  })

  it('offers at least one speaker per voice, with no repeated index', () => {
    for (const entry of VOICE_TTS_MODEL_MANIFEST) {
      expect(entry.speakers.length, entry.id).toBeGreaterThan(0)
      const ids = entry.speakers.map((s) => s.speakerId)
      expect(new Set(ids).size, entry.id).toBe(ids.length)
    }
  })

  it('never offers a withheld speaker, and says why each one is withheld', () => {
    for (const entry of VOICE_TTS_MODEL_MANIFEST) {
      const offered = new Set(entry.speakers.map((s) => s.speakerId))
      for (const withheld of entry.withheldSpeakers ?? []) {
        expect(offered.has(withheld.speakerId), `${entry.id}:${withheld.name}`).toBe(false)
        expect(withheld.reason.length, `${entry.id}:${withheld.name}`).toBeGreaterThan(8)
      }
    }
  })

  it('keeps the low-graded Kokoro speakers out of the list', () => {
    const kokoro = findTtsManifestEntry('kokoro-en-v0_19')
    expect(kokoro).toBeDefined()
    const withheld = (kokoro?.withheldSpeakers ?? []).map((s) => s.name)
    expect(withheld).toContain('af_sky')
    expect(withheld).toContain('am_adam')
    expect(withheld).toContain('bm_lewis')
    // The eleven speakers of the model, less the three above.
    expect(kokoro?.speakers).toHaveLength(8)
  })

  it('defaults to the fast voice and to a speaker that exists', () => {
    expect(DEFAULT_VOICE_TTS_MODEL_ID).toBe('kitten-nano-en-v0_2')
    for (const [modelId, speakerId] of Object.entries(DEFAULT_TTS_SPEAKER_BY_MODEL)) {
      const entry = findTtsManifestEntry(modelId)
      expect(entry, modelId).toBeDefined()
      expect(entry?.speakers.some((s) => s.speakerId === speakerId), modelId).toBe(true)
    }
  })

  it('names every file the worker has to load', () => {
    for (const entry of VOICE_TTS_MODEL_MANIFEST) {
      expect(entry.files.model, entry.id).toMatch(/\.onnx$/)
      expect(entry.files.voices, entry.id).toBeTruthy()
      expect(entry.files.tokens, entry.id).toBeTruthy()
      expect(entry.files.dataDir, entry.id).toBe('espeak-ng-data')
      expect(['kokoro', 'kitten']).toContain(entry.family)
    }
  })
})
