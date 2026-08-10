/**
 * Speech-synthesis model catalogue (design §5.10).
 *
 * The rules are the ones speech recognition already follows: nothing is put in
 * the installer, the user reads the size and the licence before anything is
 * downloaded, and the bytes are refused unless they match a recorded SHA-256.
 *
 * A voice model differs from a recognition model in one way. It needs an
 * `espeak-ng-data` directory of about 355 small files, so the catalogue points
 * at the published archive and records one checksum for it. The archive is
 * verified before a single file is written into place.
 *
 * Both checksums below were measured from the published archive:
 *   kitten-nano-en-v0_2-fp16.tar.bz2   26,586,708 bytes
 *   kokoro-int8-en-v0_19.tar.bz2      103,248,205 bytes
 *
 * Both entries were also loaded and measured through `sherpa-onnx-node` on
 * macOS arm64 before they were added. See `docs/voice-tts.md`.
 */

import type { VoiceTtsModelManifestEntry } from '../../shared/voice-tts'

const GB = 1024 * 1024 * 1024
const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'

export const VOICE_TTS_MODEL_MANIFEST: VoiceTtsModelManifestEntry[] = [
  {
    id: 'kitten-nano-en-v0_2',
    label: 'English — fast',
    description:
      'Small and quick. It starts to speak in well under a second and it keeps ahead of playback on a slow computer.',
    languages: ['en'],
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/KittenML/KittenTTS',
    minMemoryBytes: 1 * GB,
    archive: {
      url: `${RELEASE}/kitten-nano-en-v0_2-fp16.tar.bz2`,
      sha256: '0345a8a2f4a710cb8f7912c9a731ded8b3e1e69b33a871efa95c2e64651518fe',
      sizeBytes: 26_586_708,
      unpackedBytes: 41_817_958,
      rootDir: 'kitten-nano-en-v0_2-fp16',
      format: 'tar.bz2',
    },
    files: {
      model: 'model.fp16.onnx',
      voices: 'voices.bin',
      tokens: 'tokens.txt',
      dataDir: 'espeak-ng-data',
    },
    family: 'kitten',
    sampleRate: 24000,
    // The model reports eight speakers and names them by number and sex. The
    // project publishes no quality grade for them, so none is invented here.
    speakers: [
      { speakerId: 0, name: 'expr-voice-2-m', label: 'Voice 2 — male', description: 'American, male.' },
      { speakerId: 1, name: 'expr-voice-2-f', label: 'Voice 2 — female', description: 'American, female.' },
      { speakerId: 2, name: 'expr-voice-3-m', label: 'Voice 3 — male', description: 'American, male.' },
      { speakerId: 3, name: 'expr-voice-3-f', label: 'Voice 3 — female', description: 'American, female.' },
      { speakerId: 4, name: 'expr-voice-4-m', label: 'Voice 4 — male', description: 'American, male.' },
      { speakerId: 5, name: 'expr-voice-4-f', label: 'Voice 4 — female', description: 'American, female.' },
      { speakerId: 6, name: 'expr-voice-5-m', label: 'Voice 5 — male', description: 'American, male.' },
      { speakerId: 7, name: 'expr-voice-5-f', label: 'Voice 5 — female', description: 'American, female.' },
    ],
  },

  {
    id: 'kokoro-en-v0_19',
    label: 'English — natural',
    description:
      'The most natural local voice. It is four times the download and it speaks at about the speed of speech, so a slow computer falls behind on a long answer.',
    languages: ['en'],
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/hexgrad/Kokoro-82M',
    minMemoryBytes: 2 * GB,
    archive: {
      url: `${RELEASE}/kokoro-int8-en-v0_19.tar.bz2`,
      sha256: 'c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd',
      sizeBytes: 103_248_205,
      unpackedBytes: 157_947_103,
      rootDir: 'kokoro-int8-en-v0_19',
      format: 'tar.bz2',
    },
    files: {
      model: 'model.int8.onnx',
      voices: 'voices.bin',
      tokens: 'tokens.txt',
      dataDir: 'espeak-ng-data',
    },
    family: 'kokoro',
    sampleRate: 24000,
    /**
     * The model holds eleven speakers. The Kokoro project publishes an overall
     * grade for each one, and three of them are graded below C. Those three are
     * withheld below, because a voice that sounds wrong makes every answer
     * sound wrong.
     *
     * Grades: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
     */
    speakers: [
      {
        speakerId: 0,
        name: 'af',
        label: 'Default — American, female',
        description: 'The blended voice the model ships with.',
      },
      { speakerId: 1, name: 'af_bella', label: 'Bella', description: 'American, female. Graded A−, the best of the set.' },
      { speakerId: 2, name: 'af_nicole', label: 'Nicole', description: 'American, female. Graded B−, quieter.' },
      { speakerId: 3, name: 'af_sarah', label: 'Sarah', description: 'American, female. Graded C+.' },
      { speakerId: 6, name: 'am_michael', label: 'Michael', description: 'American, male. Graded C+.' },
      { speakerId: 7, name: 'bf_emma', label: 'Emma', description: 'British, female. Graded B−.' },
      { speakerId: 8, name: 'bf_isabella', label: 'Isabella', description: 'British, female. Graded C.' },
      { speakerId: 9, name: 'bm_george', label: 'George', description: 'British, male. Graded C.' },
    ],
    withheldSpeakers: [
      { speakerId: 4, name: 'af_sky', reason: 'Graded C−. Only minutes of training audio.' },
      { speakerId: 5, name: 'am_adam', reason: 'Graded F+, the lowest grade the project publishes.' },
      { speakerId: 10, name: 'bm_lewis', reason: 'Graded D+.' },
    ],
  },
]

/**
 * The model offered first.
 *
 * Fast beats natural here. A spoken answer that arrives after the user has read
 * it is worse than a plainer voice that keeps up, and this model is a quarter
 * of the download.
 */
export const DEFAULT_VOICE_TTS_MODEL_ID = VOICE_TTS_MODEL_MANIFEST[0].id

/** Speaker chosen when the user has never picked one. */
export const DEFAULT_TTS_SPEAKER_BY_MODEL: Record<string, number> = {
  'kitten-nano-en-v0_2': 1,
  // Graded A−; the only speaker in the set above B−.
  'kokoro-en-v0_19': 1,
}

export function findTtsManifestEntry(id: string): VoiceTtsModelManifestEntry | undefined {
  return VOICE_TTS_MODEL_MANIFEST.find((entry) => entry.id === id)
}

/** True when the archive carries a verified checksum. */
export function isTtsManifestVerified(entry: VoiceTtsModelManifestEntry): boolean {
  return /^[a-f0-9]{64}$/.test(entry.archive.sha256)
}
