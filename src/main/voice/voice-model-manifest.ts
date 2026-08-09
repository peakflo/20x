/**
 * Speech model catalogue (design §5.10).
 *
 * Models are never put in the installer. They are downloaded on demand after
 * the user reads the size, the language list and the licence.
 *
 * Every file carries its own SHA-256. The checksums stay empty until the
 * Phase 0 packaging spike records them, and `VoiceModelManager` refuses to
 * download an entry that has an empty checksum. An unverified model can
 * therefore never reach a user, and the release gate stays enforced in code
 * instead of in a document.
 *
 * Until a checksum is filled in, a user can still point the app at a model
 * directory they installed by hand (setting `voice_custom_model_dir`).
 */

import type { VoiceModelManifestEntry } from '../../shared/voice'

const SHERPA_RELEASE =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-26'

export const VOICE_MODEL_MANIFEST: VoiceModelManifestEntry[] = [
  {
    id: 'sherpa-streaming-zipformer-en',
    label: 'Streaming Zipformer — English',
    languages: ['en'],
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE',
    minMemoryBytes: 2 * 1024 * 1024 * 1024,
    files: [
      {
        name: 'encoder.onnx',
        url: `${SHERPA_RELEASE}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
        sha256: '',
        sizeBytes: 68_000_000,
      },
      {
        name: 'decoder.onnx',
        url: `${SHERPA_RELEASE}/decoder-epoch-99-avg-1-chunk-16-left-128.onnx`,
        sha256: '',
        sizeBytes: 2_000_000,
      },
      {
        name: 'joiner.onnx',
        url: `${SHERPA_RELEASE}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
        sha256: '',
        sizeBytes: 253_000,
      },
      { name: 'tokens.txt', url: `${SHERPA_RELEASE}/tokens.txt`, sha256: '', sizeBytes: 5_000 },
    ],
    roles: {
      encoder: 'encoder.onnx',
      decoder: 'decoder.onnx',
      joiner: 'joiner.onnx',
      tokens: 'tokens.txt',
    },
  },
]

export const DEFAULT_VOICE_MODEL_ID = VOICE_MODEL_MANIFEST[0].id

export function findManifestEntry(id: string): VoiceModelManifestEntry | undefined {
  return VOICE_MODEL_MANIFEST.find((entry) => entry.id === id)
}

/** True when every file of the entry has a verified checksum. */
export function isManifestVerified(entry: VoiceModelManifestEntry): boolean {
  return entry.files.length > 0 && entry.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256))
}

export function manifestSizeBytes(entry: VoiceModelManifestEntry): number {
  return entry.files.reduce((total, f) => total + f.sizeBytes, 0)
}
