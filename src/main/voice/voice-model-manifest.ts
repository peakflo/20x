/**
 * Speech model catalogue (design §5.10).
 *
 * Models are never put in the installer. They are downloaded on demand after
 * the user reads the size, the language list and the licence.
 *
 * Every file carries its own SHA-256, and every URL is pinned to one model
 * revision, so a download either produces the exact bytes recorded here or it
 * is refused. `VoiceModelManager` will not download an entry whose checksum is
 * empty, so an unverified model can never reach a user.
 */

import type { VoiceModelManifestEntry } from '../../shared/voice'

/**
 * Pinned revision of the model repository. Never use a branch name here: a
 * moving branch would break every checksum below.
 */
const ZIPFORMER_EN_REVISION = '672fbf1b30579d6585301139bb363f42a0ad4a24'
const ZIPFORMER_EN_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/' +
  ZIPFORMER_EN_REVISION

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
        url: `${ZIPFORMER_EN_BASE}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
        sha256: '563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1',
        sizeBytes: 71_083_163,
      },
      {
        name: 'decoder.onnx',
        url: `${ZIPFORMER_EN_BASE}/decoder-epoch-99-avg-1-chunk-16-left-128.onnx`,
        sha256: '7bf787f90b194b307e5a4ad6a34fadb4e748304c35f78a8d66358a05b13ee6ef',
        sizeBytes: 2_092_621,
      },
      {
        name: 'joiner.onnx',
        url: `${ZIPFORMER_EN_BASE}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
        sha256: 'd944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297',
        sizeBytes: 259_335,
      },
      {
        name: 'tokens.txt',
        url: `${ZIPFORMER_EN_BASE}/tokens.txt`,
        sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb',
        sizeBytes: 5_048,
      },
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
