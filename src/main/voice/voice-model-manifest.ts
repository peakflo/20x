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
 *
 * Every entry is a streaming transducer with the same four roles, so the worker
 * loads them all through one code path. The files are stored under fixed local
 * names, whatever they are called upstream.
 */

import type { VoiceModelManifestEntry } from '../../shared/voice'

const GB = 1024 * 1024 * 1024

/**
 * Pinned revisions. Never use a branch name here: a moving branch would break
 * every checksum below.
 */
const ZIPFORMER_EN =
  'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/' +
  '672fbf1b30579d6585301139bb363f42a0ad4a24'
const FAST_CONFORMER_EN =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8/resolve/' +
  'df8ed95e44a70924450381e610770f9d656d1e15'
const NEMOTRON_EN =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25/resolve/' +
  '52056fdc070914a48dcd68b31b44d6a6f5b85902'

/** All entries use these local names, so the worker never has to guess. */
const ROLES = {
  encoder: 'encoder.onnx',
  decoder: 'decoder.onnx',
  joiner: 'joiner.onnx',
  tokens: 'tokens.txt',
} as const

export const VOICE_MODEL_MANIFEST: VoiceModelManifestEntry[] = [
  {
    id: 'sherpa-streaming-zipformer-en',
    label: 'English — small',
    description: 'Fast and light. Good for task commands and short dictation.',
    languages: ['en'],
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE',
    minMemoryBytes: 2 * GB,
    files: [
      {
        name: ROLES.encoder,
        url: `${ZIPFORMER_EN}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
        sha256: '563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1',
        sizeBytes: 71_083_163,
      },
      {
        name: ROLES.decoder,
        url: `${ZIPFORMER_EN}/decoder-epoch-99-avg-1-chunk-16-left-128.onnx`,
        sha256: '7bf787f90b194b307e5a4ad6a34fadb4e748304c35f78a8d66358a05b13ee6ef',
        sizeBytes: 2_092_621,
      },
      {
        name: ROLES.joiner,
        url: `${ZIPFORMER_EN}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
        sha256: 'd944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297',
        sizeBytes: 259_335,
      },
      {
        name: ROLES.tokens,
        url: `${ZIPFORMER_EN}/tokens.txt`,
        sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb',
        sizeBytes: 5_048,
      },
    ],
    roles: { ...ROLES },
  },

  {
    id: 'nemo-fast-conformer-en-480ms',
    label: 'English — balanced',
    description: 'NVIDIA FastConformer, 480 ms chunks. Better words for free dictation.',
    languages: ['en'],
    license: 'CC-BY-4.0',
    licenseUrl: 'https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi',
    minMemoryBytes: 2 * GB,
    files: [
      {
        name: ROLES.encoder,
        url: `${FAST_CONFORMER_EN}/encoder.int8.onnx`,
        sha256: '100c5616929a131b5b3c8c8ab0d83aaba2cdcae163acd8d190b4e5ffa5f7d051',
        sizeBytes: 131_507_603,
      },
      {
        name: ROLES.decoder,
        url: `${FAST_CONFORMER_EN}/decoder.int8.onnx`,
        sha256: '4f04431988472f8c7b815f942aa6901976929c9e22353029681fcdb262da0164',
        sizeBytes: 3_955_864,
      },
      {
        name: ROLES.joiner,
        url: `${FAST_CONFORMER_EN}/joiner.int8.onnx`,
        sha256: 'd2d8e7290a6a8245a83ed211aa0dd8cdf8effb8a7c64fe392399561111b52f30',
        sizeBytes: 1_408_182,
      },
      {
        name: ROLES.tokens,
        url: `${FAST_CONFORMER_EN}/tokens.txt`,
        sha256: '618dc110fc2213886b52e063ff42329bbdf37a266ca7705184090fa5f39f3131',
        sizeBytes: 11_896,
      },
    ],
    roles: { ...ROLES },
  },

  {
    id: 'nemotron-streaming-en-560ms',
    label: 'English — most accurate',
    description:
      'NVIDIA Nemotron 0.6B, 560 ms chunks. Writes normal capitals and punctuation. Large, and it needs a fast computer.',
    languages: ['en'],
    license: 'NVIDIA Open Model License',
    licenseUrl: 'https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b',
    minMemoryBytes: 4 * GB,
    files: [
      {
        name: ROLES.encoder,
        url: `${NEMOTRON_EN}/encoder.int8.onnx`,
        sha256: '7d932213491ad355c6e5576705dc3494731a52af87d7a1b954559340147909d8',
        sizeBytes: 652_916_849,
      },
      {
        name: ROLES.decoder,
        url: `${NEMOTRON_EN}/decoder.int8.onnx`,
        sha256: '0be9702c2f427a2b6bb241d298e0d3836a558de1f5b9fd3018f1cce6e2b3fa98',
        sizeBytes: 7_257_753,
      },
      {
        name: ROLES.joiner,
        url: `${NEMOTRON_EN}/joiner.int8.onnx`,
        sha256: 'a35eac38a22ebceb04d230ed7afe0d68f446ba6914a036b97f14fece95967e23',
        sizeBytes: 1_735_862,
      },
      {
        name: ROLES.tokens,
        url: `${NEMOTRON_EN}/tokens.txt`,
        sha256: 'dc0b4584ab2e4ddbf888425c076c61b736e7356a015250db7d307e6f1a8188ff',
        sizeBytes: 8_952,
      },
    ],
    roles: { ...ROLES },
  },
]

/** The one installed automatically by the single setup action. */
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
