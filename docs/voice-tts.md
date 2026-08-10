# Spoken answers (phase 2 — text to speech)

Phase 1 gave 20x ears. This gives it a voice: it reads an agent answer aloud on
the desktop. Speech is produced on this computer. No text and no audio leave the
device.

Blueprint: the research subtask artifact `design.md`, §5.2 (provider contracts),
§5.7 (spoken answers) and §5.10 (model management).

---

## What is in it

- Two speech engines behind one contract: the voice the operating system
  already has, and a neural model that runs through the same `sherpa-onnx-node`
  runtime speech recognition installs.
- An isolated synthesis worker. One sentence is produced at a time and is sent
  the moment it exists, so playback starts after the first sentence.
- Playback in the renderer, scheduled sentence after sentence with no gap.
- Barge-in: the moment the user starts to speak, 20x stops.
- The answer that is read is the answer the user asked for, matched by voice
  turn and task.
- A speak button on every agent message, a voice sample in settings, and one
  audio state indicator shared with the microphone.

## What is not in it

OpenAI Realtime, LiveKit, a wake word, and speaking on mobile. The contracts in
`src/shared/voice-tts.ts` keep a place for each of them.

---

## Where it lives in the app

**Settings → Voice**, one page in two parts: "Speech to text — what 20x hears"
and "Text to speech — what 20x says".

The main view of each part keeps what a user acts on: switch that half on, pick
a voice, hear it, and download a model. Both catalogues stay in view, because
downloading a voice is a normal first step and not an advanced one.

Each part then has its own disclosure — "Advanced options (speech to text)" and
"Advanced options (text to speech)" — holding only the settings that already
have a good default: the engine, the reading speed, the length limit, the two
answer rules, the microphone test, the pause length and the shortcut. Each is
remembered separately, and opening one leaves the other shut.

It is a disclosure and not a switch on purpose. A switch says "this setting is
on or off"; nothing here is being switched on, and it only decides what is on
screen.

A problem is never hidden by either one: a blocked microphone or a missing voice
is stated in the main view.

## Processes

```text
Electron renderer
  Web Audio playback queue, speaking bubble, speak button
        ▲  voice:speech:start | chunk | end   (desktop window only)
        │
Electron main process
  VoiceSpeechService   policy, correlation, queue, barge-in
  VoiceSessionManager  audio state, turn identity
  VoiceTtsModelManager download, SHA-256, extraction
        │  control and audio over Node IPC
        ▼
Speech worker (separate process)
  system voice  ── say | PowerShell SAPI | espeak-ng
  local voice   ── sherpa-onnx OfflineTts (Kokoro or Kitten)
```

Audio never reaches a mobile client. The samples are produced here and played
here; a phone cannot play a raw sample stream from the local WebSocket, and
sending it would push megabytes through a text channel for nothing.
`GET /api/capabilities` says so in words the mobile composer shows.

---

## The two engines

| | This system | Downloaded voice |
|---|---|---|
| Download | none | 26 MB or 103 MB |
| Needs the speech runtime | no | yes |
| Quality | good on macOS and Windows | more natural |
| Works offline | yes | yes |

The system voice is the default, and it is why spoken answers work on the day
20x is installed: they need neither the optional speech runtime nor a model on
disk. The neural voice is one click away for anyone who wants it.

`say` on macOS, `System.Speech` through PowerShell on Windows, and `espeak-ng`
on Linux. Where none is present, the settings page says so and nothing is
spoken.

The text of an answer is written to a temporary file and the file is named on
the command line. No part of an answer is ever interpolated into a command
string, so an answer that contains quotes or shell characters cannot change the
command that runs.

---

## The voice catalogue

Two voices, both Apache-2.0, both measured on this machine before they were
added.

| Voice | Download | On disk | Speakers | Speed |
|---|---|---|---|---|
| English — fast (Kitten Nano v0.2) | 26 MB | 42 MB | 8 | about 0.18 × real time |
| English — natural (Kokoro v0.19, int8) | 103 MB | 158 MB | 8 of 11 | about 0.93 × real time |

The fast voice is offered first. A spoken answer that arrives after the user has
read it is worse than a plainer voice that keeps up, and 0.93 × real time is not
a margin that survives a slower computer.

### Which Kokoro speakers are offered, and why

The Kokoro project publishes an overall grade for every speaker. Three of the
eleven in this model are graded below C and are not offered:

| Speaker | Grade | Offered |
|---|---|---|
| af_bella | A− | yes, and it is the default |
| af_nicole | B− | yes |
| bf_emma | B− | yes |
| af_sarah | C+ | yes |
| am_michael | C+ | yes |
| bf_isabella | C | yes |
| bm_george | C | yes |
| af (blend) | not graded | yes |
| bm_lewis | D+ | no |
| af_sky | C− | no |
| am_adam | F+ | no |

The withheld speakers stay in `voice-tts-manifest.ts` with the reason beside
them, so the decision is visible in code and not only in this file.

Source: <https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md>.

### A dropped download is expected, and is resumed

Measured in the Electron main process, the 26 MB archive dropped part of the way
through at 19.5 MB and at 8.8 MB on consecutive attempts, through both the Node
and the Chromium network stack, while the same request from plain Node
completed. A single-shot fetch reports that to the user as `TypeError:
terminated`.

So a drop is treated as ordinary. The bytes already on disk are kept, the next
attempt asks for the rest with a `Range` header, and six interruptions are
absorbed before the user is told — in a sentence, not as a `TypeError`. A
download that arrives whole and still fails its checksum is not retried: those
are the bytes the server serves, and fetching 100 MB again would reach the same
answer.

### Why an archive and not loose files

Every neural voice needs an `espeak-ng-data` directory of about 355 files.
Downloading those one at a time would be slow and impossible to keep verified,
so the catalogue points at the published `.tar.bz2` and records one SHA-256 for
it. Nothing is unpacked until that value matches, every entry name is checked
before a byte is written, and an entry that climbs out of the model directory is
refused.

---

## What is read, and what is not

Only these five reasons produce speech, and each has its own condition:

| Reason | Condition |
|---|---|
| the answer to a spoken question | spoken answers are on, and the question was asked by voice |
| a short action result, such as “Task created.” | spoken answers are on, and that switch is on |
| “read the last answer” | always: the user asked for it |
| the voice sample in settings | always |
| the speak button on a message | always |

A code block, a table, a file path, a link, a heading mark and every other piece
of Markdown punctuation are removed before anything is spoken. A code block is
named — “A code block of 12 lines is in the message.” — rather than read.
Automatic speech stops at a character limit, and the speak button reads the rest.

### The answer that is read is the answer you asked for

When a spoken command sends a question to an agent, the task and the voice turn
are recorded together. The answer that arrives minutes later is matched against
that record, is consumed by the first answer, and expires after ten minutes.
Without this, a background task finishing an hour later would be read out over
whatever the user is doing.

The rule can be switched off in settings, and then every agent answer is read.

### Where the answer comes from

The `working → idle` edge on the agent status stream is the only moment at
which a whole answer exists. The text is then read from the stored transcript,
not from memory, so it also works after a restart and after the session has been
released.

Only a plain assistant text part counts. Tool output, a question, an error and
hidden reasoning are skipped.

---

## Talking over an answer

In a conversation the microphone stays open while an answer is read, so the
microphone hears the loudspeaker. Two things have to hold at once, and echo
cancellation alone is not trusted for either: it is a browser feature whose
reference signal differs by platform, and one leaked sentence would be enough to
make 20x answer itself.

**The recogniser is never given 20x's own voice.** While an answer is being
read, the microphone audio is held back instead of being sent. So an answer
cannot be transcribed as if the user had said it.

**The user can still interrupt by speaking.** The held audio is measured. Speech
from a person is far louder than what the echo canceller leaves behind, so a
passage that stays above `BARGE_IN_LEVEL` for `BARGE_IN_HOLD_MS` means the user
is talking. The answer stops at once, and the held audio — about half a second
of it — is released to the recogniser, so the reply is recognised from its first
word rather than from its second.

One short knock does not cut an answer off: the level has to hold, not merely
peak.

### And then the loop closes

When that reply is recognised it is sent, exactly as any spoken sentence is, and
the answer that comes back is read aloud in turn. The renderer names the task it
sent to, so the right answer is spoken. The Mastermind drawer sends on its own
behalf and can name no task, so the next answer to arrive within ninety seconds
is taken as the reply — armed only by the user having just spoken, and consumed
once.

## Barge-in by hand

The moment a voice turn opens, playback stops in the renderer in the same tick
as the press, and main tells the worker to stop producing. Escape stops speech,
and so does a click on the speaking indicator.

The local model call blocks its process for about a second, so a sentence is
capped at about 240 characters. That is what keeps cancellation quick: a
`cancel` message can only be read between sentences.

---

## Measured on this machine

macOS 14, Apple M1 Pro, `sherpa-onnx-node`, two sentences, through the real
worker protocol.

| Engine | Load | First audio | Total | Audio produced |
|---|---|---|---|---|
| Kitten Nano v0.2 | 605 ms | 422 ms | 1.43 s | 7.80 s |
| Kokoro v0.19 int8 | 720 ms | 1347 ms | 4.20 s | 4.54 s |
| macOS `say` | — | 1833 ms | 4.11 s | 4.06 s |

### Electron will not read the runtime's own memory

`sherpa-onnx-node` returns its samples in memory the addon owns, unless the
request says otherwise. Electron refuses to wrap that memory — "External buffers
are not allowed" — and the whole turn fails, while the identical call from plain
Node succeeds. The worker runs inside Electron, so every request sets
`enableExternalBuffer: false` and takes a copy.

This is worth remembering beyond this feature: a native addon that works in a
Node script can still fail in the app, so a runtime path has to be proved under
Electron and not only under Node.

### One finding worth keeping

`sherpa-onnx-node` exposes a streaming callback, `generateAsync({ onProgress })`.
On the version measured here it delivered no chunks at all and then ended the
process with an out-of-memory abort. The synchronous call per sentence is used
instead, which is why a sentence is capped and why the worker waits for each
message to be flushed before it starts the next sentence. Without that flush the
first sentence only reached the parent after the last one had been produced —
playback started at the end of the answer instead of at the beginning.

---

## Files

| File | Role |
|---|---|
| `src/shared/voice-tts.ts` | Contracts, settings keys, IPC names, spoken-text rules |
| `src/main/voice/voice-tts-manifest.ts` | Voice catalogue and speaker selection |
| `src/main/voice/voice-tts-model-manager.ts` | Download, SHA-256, safe extraction |
| `src/main/voice/voice-tts-worker.js` | The synthesis worker (plain CommonJS) |
| `src/main/voice/voice-tts-worker-client.ts` | Worker lifecycle |
| `src/main/voice/voice-system-voices.ts` | The voices the system already has |
| `src/main/voice/voice-speech-service.ts` | Policy, correlation, queue, barge-in |
| `src/renderer/src/lib/voice-playback.ts` | Web Audio playback queue |
| `src/renderer/src/components/voice/SpeakMessageButton.tsx` | Read one message |
| `src/renderer/src/components/settings/tabs/SpokenAnswerSettings.tsx` | Settings |

---

## Release gates still open

Spoken answers are off by default, so none of these blocks the rest of the app.

- [ ] Measure the two neural voices on Windows x64 and Linux x64. Only macOS
      arm64 is measured above.
- [ ] Confirm the Windows SAPI path on a real Windows install. It is written
      from the documented API and is not yet run on the machine.
- [ ] Licence review of both voice model cards, as design §5.10 requires before
      a voice reaches a user.
- [ ] A packaged-system test: no audio output device, a device change while
      speaking, and a very long answer.
