# Voice control (phase 1 — speech to text)

Voice control lets a user dictate into 20x and run a small set of task commands
by speech. Speech recognition runs on the user's computer. No audio is stored,
and no audio leaves the device.

This document describes what is implemented. The blueprint is the research
subtask design (`design.md`, "FluidVoice and local voice integration
feasibility for 20x desktop"). Section numbers below refer to that document.

## What phase 1 contains

- An **optional** install of the local speech runtime, offered in the setup
  dialog and in Voice settings. Nothing voice-related is downloaded until the
  user asks for it, and every voice control stays hidden until it is present.
- Microphone capture in the renderer, with push-to-talk.
- A separate speech worker process with the local runtime.
- Live partial text and one final transcript for each turn.
- A closed set of task commands, each with a validation and a confirmation step.
- A voice surface in the app: audio state, transcript bubble, confirmation card.
- Voice settings: enable, permission state, model download, global shortcut.

## What phase 1 does not contain

Agent answers stay text. There is no spoken answer, no barge-in, no wake word,
no cloud provider, and no microphone on mobile. Every one of these is a phase 2
item in the design, and the contracts in `src/shared/voice.ts` leave room for
them.

Do not describe this release as ChatGPT voice mode. It is local dictation and
local task commands.

## Processes

```text
renderer
  getUserMedia + AudioWorklet -> 16 kHz mono 16-bit PCM
  mic button, transcript bubble, confirmation card
        │  voice:* IPC, about 100 ms of audio per message
        ▼
main process
  VoiceSessionManager   state machine, turn identity, shortcut, models
  VoiceIntentParser     closed intent union, deterministic rules
  VoiceActionService    target resolution, confirmation policy, execution
        │  control over Node IPC, audio over stdin
        ▼
voice worker (separate process)
  local runtime, streaming recognition, partial and final text
```

| File | Role |
|---|---|
| `src/shared/voice.ts` | Contracts, state machine, channels, settings keys |
| `src/shared/voice-intent-parser.ts` | Deterministic parser and the schema guard |
| `src/main/voice/voice-session-manager.ts` | Session owner |
| `src/main/voice/voice-action-service.ts` | Target resolution and task actions |
| `src/main/voice/voice-model-manager.ts` | Download, checksum, delete |
| `src/main/voice/voice-model-manifest.ts` | Model catalogue |
| `src/main/voice/voice-runtime-installer.ts` | Optional install of the runtime |
| `src/main/voice/voice-worker-client.ts` | Worker lifecycle and audio pipe |
| `src/main/voice/voice-worker.js` | The worker itself (plain CommonJS) |
| `src/renderer/src/lib/voice-capture.ts` | Microphone capture |
| `src/renderer/src/lib/voice-dictation-target.ts` | The one field that receives words |
| `src/renderer/src/stores/voice-store.ts` | Renderer state |
| `src/renderer/src/components/voice/*` | Microphone button, overlay, runtime row |

## Commands

| Speech | Action | Confirmation |
|---|---|---|
| "create a task to fix login" | `DatabaseManager.createTask` | Yes, unless quick create is on |
| "assign this to Codex" | `agent_id` update | Only when the name is not unique |
| "start this task" | `AgentManager.startTask` | Yes when no agent is assigned |
| "ask the agent why the test failed" | `AgentManager.sendByTaskId` | No |
| "approve" / "reject" | `AgentManager.respondToPermission` | Always |
| "open the dashboard" | Renderer navigation | No |
| "read the last answer" | Last assistant message, as text | No |
| "cancel" | Ends the turn | No |

Two modes keep dictation and commands apart:

- The microphone button in a text composer runs in `dictation` mode. The parser
  is not used at all, so spoken words can never run an action.
- The global shortcut runs in `command` mode.

One click starts listening and a second click stops it. Escape cancels the turn
and keeps the words out.

### The conversational loop

This is the default in a task composer:

```text
click → listening → you speak → you pause
                        ↓
        end of turn detected (endpoint rule)
                        ↓
        sentence written into the box and sent
                        ↓
        still listening → you speak again → …
                        ↓
                click again to stop
```

The microphone stays open for the whole conversation. Each pause ends one
sentence, the sentence is sent at once, and the recogniser is reset for the
next one — all on the same audio stream, so nothing is missed between
sentences.

The pause length is the endpoint rule of the recogniser (`rule2`), set in
**Settings → Voice → A pause this long ends a sentence**: 0.8 s, 1.2 s
(default), or 2 s. Changing it reloads the model.

Guards:

- A conversation never runs the intent parser, exactly like dictation, so a
  spoken sentence can never execute a task action.
- A segment shorter than two characters is noise and is dropped, because the
  renderer would send it straight away.
- A conversation stops after ten minutes of one open turn.
- **Settings → Voice → Keep talking** switches the loop off; the words are then
  written into the box for you to send yourself.

### Where dictated words go

The transcript panel is mounted many times at once — the task workspace, each
canvas panel, and the Mastermind drawer. So there is exactly **one** dictation
target, and the microphone button that started the turn claims the field of its
own composer (`data-voice-composer`). Exactly one subscriber writes the words.

A turn started from the global shortcut, or from the test button in settings,
claims no field, so the words are inserted nowhere.

### Testing the microphone

**Settings → Voice → Test the microphone** records one turn, shows a level meter
and the words it heard, and writes them nowhere else.

Text after "ask the agent" stays verbatim. A command inside that message is
never executed.

## Safety rules

These rules are enforced in code and covered by tests:

1. Only members of the closed `VoiceIntent` union run. `isVoiceIntent()` rejects
   everything else before any database or agent call.
2. Approve and reject need a visible pending approval, a session that still
   reports `waiting_approval` for that same task, and a second confirmation on
   screen. A mis-heard "reject" cannot approve.
3. A partial title match never starts, assigns, approves, or rejects without a
   confirmation. Two or more matches produce a choice of at most three records.
4. Audio from an old turn, and partial text from an old turn, are dropped.
5. The main process stays the only mutation writer. Each action emits one
   canonical `task:created` or `task:updated` event, which reaches the desktop
   renderer and the mobile clients.
6. Confirmation is visual. A spoken "yes" confirms nothing.

## Permissions and privacy (§5.9)

- The microphone is requested only after the user switches voice on.
- macOS: `NSMicrophoneUsageDescription` is set through electron-builder
  `extendInfo`, and `com.apple.security.device.audio-input` is in both
  entitlement files. Main reads and requests access with `systemPreferences`.
- One `setPermissionRequestHandler` on the default session grants audio capture
  to the 20x window only, and only while voice is on. Video capture is refused.
- No audio is stored, and no audio is sent to analytics. The worker reports a
  frame count and an elapsed time for one turn, nothing else.

## Models (§5.10)

Three English models are offered. **Settings → Voice** downloads, deletes, and
chooses between them; the one in use is marked, and a second click on **Use**
switches the worker to another downloaded model.

| Model | Size | Licence | Use it for |
|---|---:|---|---|
| English — small (Zipformer) | 73 MB | Apache-2.0 | task commands, short dictation (default) |
| English — balanced (NeMo FastConformer, 480 ms) | 137 MB | CC-BY-4.0 | free dictation |
| English — most accurate (Nemotron 0.6B, 560 ms) | 662 MB | NVIDIA Open Model | long dictation; writes normal capitals and punctuation |

The NVIDIA Open Model License was reviewed and accepted for the Nemotron entry.

All three are streaming transducers with the same four roles — encoder, decoder,
joiner, tokens — so one code path in the worker loads every one of them. Adding
a fourth is a manifest entry and four checksums, no code.

Measured on an Apple Silicon machine, CPU only, feeding 16.4 s of audio in the
20 ms frames the renderer really sends:

| Model | Load | Processing | Real-time factor | Segments found |
|---|---:|---:|---:|---:|
| small | 1.2 s | 0.8 s | 0.05 | 2 |
| balanced | 0.9 s | 0.7 s | 0.04 | 2 |
| most accurate (Nemotron) | 2.1 s | 2.5 s | 0.15 | 2 |

All three keep up with a live conversation with room to spare, and all three
segment correctly. Nemotron is the only one that writes capitals **and**
punctuation.

An earlier note in this file said Nemotron was close to real time. That was
wrong: it came from pushing a whole clip in one call, which is not how
streaming works. Measure with real frame sizes.

`VoiceModelManager` downloads on request, shows the size, the language and the
licence first, verifies a SHA-256 for each file, resumes an interrupted
download, and can delete one model or all of them. Deleting the model in use
falls back to another one that is on disk.

Each URL is pinned to one model revision, never to a branch, so a checksum
cannot go stale under the app. A model whose checksum is empty is refused.

A model directory installed by hand is still accepted, in
**Settings → Voice → Use another model directory**. Choosing a catalogue model
clears it, so the choice is always what runs.

## The local runtime — an optional install

`sherpa-onnx-node` is **not** a dependency of this package and is **not** in the
application bundle:

- The Phase 0 spike must first prove packaging, signing, memory and latency on
  macOS arm64, macOS x64, Windows x64 and Linux x64 (design §6, Phase 0).
- A missing runtime must not break `pnpm install` or a release build.
- A user who never turns voice on must not pay for it in download size.

### One action installs everything

Two places offer the same control (`VoiceRuntimeRow`):

1. the setup dialog, as an optional row below the agent choice,
2. **Settings → Voice**, at the top of the page.

The control names the total download size before anything happens. One press
then does all of this, and nothing is left to do by hand:

1. `npm install sherpa-onnx-node` into `<userData>/voice-runtime` — never into
   the application bundle, which is read-only once packaged. A private
   `package.json` there keeps npm from walking up into the app. npm output is
   streamed to the user, so a failure is readable, and when npm itself is
   missing the installer says so and downloads nothing.
2. the default English speech model, if none is present, checksum-verified.
3. the model is selected and loaded in the worker.

The runtime is the first 60 % of the reported progress, the model the rest. If
the runtime is already there, only the model is fetched, and the button reads
**Finish setup**.

`VoiceWorkerClient` starts the worker with `VOICE_ENGINE_MODULE` set to the
absolute path of the installed package.

After that the user has one thing left: switch **Enable voice control** on. That
step is separate because it asks for the microphone.

### What the user sees without it

Nothing. `selectVoiceReady()` requires an installed runtime, a loaded model, and
`enabled`, and both the microphone button and the voice overlay return null
otherwise. The enable
switch in Voice settings is disabled, and the speech-model section is hidden,
because neither can do anything yet.

"Remove" deletes the runtime directory and switches voice off.

For development and for the automated tests, `VOICE_ENGINE=mock` selects a
deterministic engine that returns `VOICE_MOCK_TEXT`. It never invents words.

## A turn must always close

A turn that is never cleared in the renderer is the worst failure this feature
has, because one stranded turn:

- leaves the microphone open,
- keeps the Stop control on screen with nothing behind it, and
- **disables every microphone button in the app**, since each one sees another
  turn in progress.

Four paths close a turn, and all four are tested:

1. the user stops it — cleared at once, without waiting for main;
2. the worker ends it at a pause — `voice:final` clears it;
3. a dictation outcome arrives — cleared;
4. main reports `idle` — cleared whatever the renderer believed. Main owns the
   state machine, so this last rule catches any path not foreseen.

Main also cancels an open turn before it installs, selects, or deletes a model,
or changes the pause length, because the worker swaps the model underneath.

## Two limits that stop voice after a few turns

Both are handled, and both are easy to reintroduce:

1. **One AudioContext for the window.** Chromium allows about six per document
   and frees a closed one asynchronously, so a context per turn stops working
   after a few turns. `VoiceCapture` builds the context and the worklet once and
   reuses them; only the microphone stream is per turn. `release()` frees the
   graph when voice is switched off.
2. **The worker releases the model after five idle minutes** to give the memory
   back. `startTurn()` reloads it rather than failing, or voice would go quiet
   with no message.

## Proven against the real runtime

The recogniser configuration was verified against `sherpa-onnx-node` 1.13.4 with
the catalogue model. Real speech through the real worker, over the real
protocol, produced streaming partials and this final transcript:

```text
AFTER EARLY NIGHTFALL THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE THE
SQUALID QUARTER OF THE BROTHELS
```

Model load took about 1.1 s; the tail decode after the turn ended took 431 ms.

The model paths, the token file and the thread count must sit inside
`modelConfig`. A flat configuration is rejected by the library with
"Errors in config!". `voice-worker-client.test.ts` holds a check that loads the
real recogniser whenever a machine has the runtime and a model installed, so
this shape cannot drift again. It skips elsewhere, so CI stays green.

## Release gates still open

From design §8, these gates are not met yet and must be closed before the
feature is offered to users:

- [x] Record a SHA-256 for every catalogue model file.
- [ ] Pin an exact `sherpa-onnx-node` version in `voice-runtime-installer.ts`.
- [x] Start `sherpa-onnx-node` on macOS arm64 with real speech.
- [ ] Package and start `sherpa-onnx-node` on the other three desktop targets.
- [ ] Measure partial and final latency against the §3.5 targets on each target.
- [ ] Licence review of the runtime, the model and the tokens file.
- [ ] Packaged-system tests from §7 (microphone grant, denial, device change,
      8 GB machine, offline start, app update with installed models).

Voice is off by default, so none of these blocks the rest of the app.

## Testing

```bash
pnpm test:run --project main src/main/voice
pnpm test:run --project main src/shared/voice-intent-parser.test.ts
pnpm test:run --project renderer src/renderer/src/stores/voice-store.test.ts
```

`voice-worker-client.test.ts` forks the real worker with the mock engine, so the
process lifecycle, the control channel and the audio pipe are all covered
without a native runtime.
