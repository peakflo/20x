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

Models are not in the installer. `VoiceModelManager` downloads them on request,
shows the size, the language list and the licence first, verifies a SHA-256 for
each file, resumes an interrupted download, and can delete everything.

Each URL is pinned to one model revision, never to a branch, so a checksum
cannot go stale under the app. A model whose checksum is empty is refused, so an
unverified model can never reach a user.

A model directory installed by hand is still accepted, in
**Settings → Voice → Use another model directory**, but it is not needed: the
one-action setup below downloads a verified model.

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

## Release gates still open

From design §8, these gates are not met yet and must be closed before the
feature is offered to users:

- [x] Record a SHA-256 for every catalogue model file.
- [ ] Pin an exact `sherpa-onnx-node` version in `voice-runtime-installer.ts`.
- [ ] Package and start `sherpa-onnx-node` on all four desktop targets.
- [ ] Measure partial and final latency against the §3.5 targets.
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
