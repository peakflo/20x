/**
 * Isolated speech-to-text worker (design §5.1 "Local voice worker").
 *
 * The worker is a separate process on purpose. Model loading and decoding must
 * never run on the Electron main event loop or in the renderer, and a model
 * failure must not stop the user interface.
 *
 * Protocol
 *   control  : Node IPC channel, one JSON object per message (see below)
 *   audio    : stdin, length-prefixed frames — [uint32 LE byte length][int16 LE PCM]
 *
 * Main to worker : load | start | end | cancel | unload | ping
 * Worker to main : status | partial | final | error | pong | metrics
 *
 * The runtime (`sherpa-onnx-node`) is required lazily. When it is absent the
 * worker reports `engine_missing` and exits cleanly, so a build without the
 * native runtime still starts and simply keeps voice switched off.
 *
 * Phase 1 is push-to-talk, so the user's hold marks the start and the end of a
 * turn. Turn boundaries therefore come from the recogniser's endpoint rule, not
 * from a separate VAD model. A standalone VAD is only needed for the phase 2
 * wake word, and it fits behind this same protocol.
 */

'use strict'

const SAMPLE_RATE = 16000
/** Stop a turn that never ends, so a stuck renderer cannot grow memory. */
const MAX_TURN_MS = 60000

let engine = null
let recognizer = null
let stream = null
let currentTurn = null
let turnTimer = null
let lastPartial = ''
let turnFrames = 0
let turnStartedAt = 0

function send(message) {
  if (process.send) process.send(message)
}

function fail(code, message) {
  send({ t: 'error', code, message })
}

// ── Engine loading ──────────────────────────────────────────

function loadEngine() {
  if (engine) return engine
  const moduleName = process.env.VOICE_ENGINE_MODULE || 'sherpa-onnx-node'
  if (process.env.VOICE_ENGINE === 'mock') {
    engine = createMockEngine()
    return engine
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  engine = require(moduleName)
  return engine
}

/**
 * A deterministic engine used by the automated tests and by `pnpm dev` on a
 * machine without the native runtime. It never invents words: it returns only
 * `VOICE_MOCK_TEXT`, so a test can drive the protocol without a model.
 */
function createMockEngine() {
  return { __mock: true, text: process.env.VOICE_MOCK_TEXT || '' }
}

// ── Commands ────────────────────────────────────────────────

const handlers = {
  load(message) {
    try {
      const sherpa = loadEngine()
      if (sherpa.__mock) {
        recognizer = { mock: true, text: sherpa.text }
        send({ t: 'status', state: 'ready', modelId: message.modelId || 'mock', engine: 'mock' })
        return
      }
      const started = Date.now()
      // The model paths and the thread count belong inside `modelConfig`. A
      // flat object is rejected by the runtime with "Errors in config!".
      recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: message.model.encoder,
            decoder: message.model.decoder,
            joiner: message.model.joiner,
          },
          tokens: message.model.tokens,
          numThreads: message.numThreads || 2,
          provider: 'cpu',
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: 1,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20,
      })
      send({
        t: 'status',
        state: 'ready',
        modelId: message.modelId,
        engine: 'sherpa-onnx',
        loadMs: Date.now() - started,
      })
    } catch (err) {
      recognizer = null
      const missing = err && (err.code === 'MODULE_NOT_FOUND' || /cannot find module/i.test(String(err.message)))
      send({
        t: 'status',
        state: missing ? 'engine_missing' : 'error',
        message: missing
          ? 'The local speech runtime is not installed in this build.'
          : String((err && err.message) || err),
      })
    }
  },

  start(message) {
    if (!recognizer) return fail('not_ready', 'No speech model is loaded.')
    currentTurn = message.turnId
    lastPartial = ''
    turnFrames = 0
    turnStartedAt = Date.now()
    if (!recognizer.mock) {
      stream = recognizer.createStream()
    }
    clearTimeout(turnTimer)
    turnTimer = setTimeout(() => {
      if (currentTurn) handlers.end({ turnId: currentTurn })
    }, MAX_TURN_MS)
  },

  end(message) {
    if (!currentTurn || message.turnId !== currentTurn) return
    clearTimeout(turnTimer)
    const turnId = currentTurn
    currentTurn = null
    let text = ''
    if (recognizer.mock) {
      text = recognizer.text
    } else if (stream) {
      // Flush the tail so the last word is decoded.
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(SAMPLE_RATE * 0.4) })
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      text = (recognizer.getResult(stream).text || '').trim()
      stream = null
    }
    // The frame count and the elapsed time are the only per-turn measurements
    // that leave the worker. No audio is kept and none is written to disk.
    send({ t: 'final', turnId, text, frames: turnFrames, elapsedMs: Date.now() - turnStartedAt })
  },

  cancel(message) {
    if (message.turnId && message.turnId !== currentTurn) return
    clearTimeout(turnTimer)
    currentTurn = null
    stream = null
    lastPartial = ''
  },

  unload() {
    clearTimeout(turnTimer)
    currentTurn = null
    stream = null
    recognizer = null
    send({ t: 'status', state: 'unloaded' })
  },

  ping() {
    send({ t: 'pong', rss: process.memoryUsage().rss })
  },
}

process.on('message', (message) => {
  const handler = handlers[message && message.t]
  if (!handler) return
  try {
    handler(message)
  } catch (err) {
    fail('handler_failed', String((err && err.message) || err))
  }
})

// ── Audio input ─────────────────────────────────────────────

let buffered = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
  for (;;) {
    if (buffered.length < 4) return
    const length = buffered.readUInt32LE(0)
    if (buffered.length < 4 + length) return
    const frame = buffered.subarray(4, 4 + length)
    buffered = buffered.subarray(4 + length)
    onAudioFrame(frame)
  }
})

function onAudioFrame(frame) {
  if (!currentTurn) return
  turnFrames += 1
  if (!stream || !recognizer || recognizer.mock) return
  const samples = new Float32Array(frame.length / 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = frame.readInt16LE(i * 2) / 32768
  }
  try {
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    while (recognizer.isReady(stream)) recognizer.decode(stream)
    const text = (recognizer.getResult(stream).text || '').trim()
    if (text && text !== lastPartial) {
      lastPartial = text
      send({ t: 'partial', turnId: currentTurn, text })
    }
  } catch (err) {
    fail('decode_failed', String((err && err.message) || err))
  }
}

process.on('uncaughtException', (err) => {
  fail('worker_crashed', String((err && err.message) || err))
  process.exit(1)
})
