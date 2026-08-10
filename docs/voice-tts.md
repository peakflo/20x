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
- An answer is read as it is written, not after the agent stops.
- An isolated synthesis worker. One sentence is produced at a time and is sent
  the moment it exists, so playback starts after the first sentence.
- Playback in the renderer: each piece is played the moment it arrives and the
  next is scheduled where the last one ends, so there is no gap.
- Barge-in: the moment the user starts to speak, 20x stops.
- The answer that is read is the answer the user asked for, matched by voice
  turn and task.
- A speak button on every agent message, and a voice sample in settings.
- Nothing on screen while an answer is read. The user hears it; a bubble that
  says so repeats what the ears already know and covers the window while it
  does it. Escape stops the reading, and so does speaking.

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
  Web Audio playback queue, speak button
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

## Speaking follows listening

An answer is read **only while the microphone is open**. Stop listening and
20x stops talking, at once — an answer read to a closed microphone is read to
nobody, and it talks over whatever the user turned to next.

Three rules carry it:

- A written answer does not begin to be read unless a turn is open. One that
  began while the microphone was open is allowed to finish.
- Ending or cancelling a turn interrupts whatever is being read.
- Sending a message by typing drops the expectation of a spoken answer, so the
  reply to typing stays silent. A spoken sentence goes through the same send
  and arms a fresh expectation straight afterwards, so the conversation loop is
  unaffected.

The last of those closed a real hole. An expectation says "an answer from this
task is the reply to something said out loud" and it lived for ten minutes. A
message typed into that task within those ten minutes had its reply read aloud.
The unnamed expectation was worse: it matches **any** task, so speaking into
the drawer made the next answer from anywhere eligible.

A conversation turn stays open for the whole of an answer, so the voice loop is
unaffected. A command or a dictation turn closes as soon as the words are
recognised, so an answer that arrives after it is not read.

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

### Every message of a turn is read, not only the last

One turn can hold several messages: the agent says something, uses a tool, and
says something else. All of them are the answer.

Progress is therefore kept per message rather than for "the newest" one. Taking
the newest skipped the first message entirely whenever both landed in a single
transcript flush, which is what a quick tool call produces. Every message that
is not the last one is finished by definition, so its closing sentence is
released rather than held back for a full stop that will never come.

The turn is bounded by the user's last message. The stored transcript holds the
whole conversation, and without that bound the close of a turn would replay
every answer the agent had ever given on the task.

### It is read as it is written

An agent answer arrives a few words at a time. Waiting for the agent to stop
before saying the first word would put the whole spoken answer behind the
agent — on a long answer, minutes behind.

So the passage opens before a single word has arrived, and it is filled as the
answer is written. The transcript is followed as it changes; each sentence that
is certainly finished is handed to the worker at once, and the tail is held
back, because "The test failed" and "The test failed to start" are read very
differently and the difference is one word that has not arrived yet.

The `working → idle` edge then reads the last words and closes the passage. It
is also the fallback: an answer that produced no transcript event is read in one
piece from what was stored.

A sentence is never read twice, an answer written in several pieces is read on
without a break, and the reading limit applies to the whole answer rather than
to each piece.

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

**The user can still interrupt by speaking.** The held audio is measured
against the room, not against a number chosen in advance: the floor is the
quietest of the last second, and a passage several times louder than that, held
for `BARGE_IN_HOLD_MS`, means a person is talking. The answer stops at once and
the held audio — about half a second of it — is released to the recogniser, so
the reply is recognised from its first word rather than its second.

The fixed level it replaced did not work. It was 0.06, taken from "ordinary
speech sits near 0.05 to 0.2". But the microphone runs with echo cancellation,
noise suppression and automatic gain control all on, and all three fight the
user's voice at exactly the moment it overlaps the loudspeaker — two people
talking at once is where they are weakest. A quiet talker, or one a metre from
the machine, never reached 0.06. The gate held every word and 20x carried on as
if nothing had been said.

`BARGE_IN_LEVEL` survives as the absolute floor, 0.015, so a silent room can
never count. Above that the bar is `BARGE_IN_FLOOR_FACTOR` times what is
measured. The measurement needs `BARGE_IN_FLOOR_MIN_SAMPLES` batches before it
is trusted, or a user who speaks from the very first batch would set the floor
to their own voice and raise the bar above themselves.

One short knock does not cut an answer off: the level has to hold, not merely
peak.

### A net under the gate

If a word reaches the recogniser while an answer is being read, 20x stops —
whatever the gate did or failed to do.

That is not a second barge-in. It is an admission that the gate can be wrong:
words only reach the recogniser through the gate, so a recognised word while
reading proves the gate was not holding, and a gate that is not holding never
fires. Without the net the user's sentence was heard, sent, answered — and the
previous answer carried on underneath all of it.

The gate stays the primary mechanism. It keeps 20x's own voice out of the
recogniser, and it fires about 300 ms before the first word is recognised. The
net only catches what it drops.

Both paths log one line, so the next report comes with numbers instead of
guesses: what the measured threshold was, and whether the gate was holding.

### Stopping has to be final

Stopping the passage is not enough, and user testing found this the hard way:
20x stopped, then carried straight on reading.

The agent is usually still writing the message it was cut off in, and the
sentence that interrupted it has just been sent — which registers a fresh
expectation for an answer. The agent's next few words then arrived as an
ordinary transcript change, found no passage open, and opened a new one against
that expectation. Because a new passage starts from nothing, 20x read the
interrupted message again **from its first word**.

So barge-in does not call `stop`. It calls `interrupt`, which first records
every message of the passage as silenced. A transcript part id is never reused,
so:

- the rest of the interrupted message is never read, by any path — as it
  streams, when the agent stops, or through the one-piece fallback;
- a passage is not even opened for it, so the expectation left by the
  interrupting sentence is not consumed;
- the answer to the sentence that interrupted is a new message with a new id,
  and it is read normally.

The speak button is unaffected. It asks for one named message out loud, and
that was never silenced.

The record is bounded — `VOICE_SILENCED_TASKS` tasks, `VOICE_SILENCED_PARTS_PER_TASK`
messages each — because it outlives every passage and 20x runs for days.

### And it has to cut the sentence, not finish it

Stopping was still heard as 20x finishing the sentence it was inside. The cause
was one announcement too many.

Main announces `speechStart` on **every push**, not once per passage — four
times for a three-sentence answer. The renderer opened a passage on each one,
and opening a passage drops whatever is queued. So:

- in ordinary playback, every new sentence cut off the sentence before it,
  whenever the voice produced faster than it played — which the fast voice
  always does;
- after barge-in, the next push re-opened the passage the user had just
  stopped, and the sentence main was still producing played out in full.

Two things fix it. Opening the passage that is already open now does nothing,
so an announcement can no longer drop the queue. And the renderer remembers the
passage the user stopped and ignores every later start and sentence for it —
which it must, because main cannot stop mid-sentence: the voice call blocks its
process, so a `cancel` is only read between sentences.

Every path that stops speech by hand — barge-in, the stop button, Escape,
opening a turn — goes through one function, so no path can forget a step.

### The gate has to be told when playback stops

The gate holds the microphone back while an answer plays, and only two things
open it again: barge-in firing, or being told the answer has stopped.

`reset()` does neither — it forgets the held audio and keeps holding. Anything
that stops playback by hand must therefore call `setSpeaking(false)` as well.
Opening a turn used to call only `reset()`, and the `speechEnd` that followed
was dropped because it named a passage that was already gone. The gate then held
every word the user spoke into the turn it had just opened.

### And then the loop closes

When that reply is recognised it is sent, exactly as any spoken sentence is, and
the answer that comes back is read aloud in turn. The renderer names the task it
sent to, so the right answer is spoken. The Mastermind drawer sends on its own
behalf and can name no task, so the next answer to arrive within ninety seconds
is taken as the reply — armed only by the user having just spoken, and consumed
once.

## Barge-in by hand

The moment a voice turn opens, playback stops in the renderer in the same tick
as the press, and main tells the worker to stop producing. Escape stops speech
as well. Every one of these paths silences the message, exactly as speaking over
it does.

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

### Why the model's own streaming callback is not used

`sherpa-onnx-node` exposes `generateAsync({ onProgress })`, which looks like the
way to get audio out of the model as it is produced. It is not used, for two
measured reasons.

It does not stream below a sentence. On the fast voice, a three-sentence passage
produced two or three callbacks — one per sentence group — not a steady flow of
partial audio. Splitting the text here and generating one sentence at a time
gives the same granularity and gives it sooner, because the split is chosen
rather than inherited.

And it ends the process. After one or two calls it aborts with
`v8::ArrayBuffer::New Allocation failed — process out of memory`, with or
without `enableExternalBuffer: false`:

```text
call 1: survived, callbacks=3
call 2: survived, callbacks=2
FATAL ERROR: v8::ArrayBuffer::New Allocation failed - process out of memory
```

An earlier note in this file said the callback "delivered no chunks and then
aborted". The abort was real; the empty delivery was the external-buffer fault
described above, and it is fixed. The callback still aborts, so the synchronous
call per sentence stands.

### The voice is loaded again after it is released

The worker gives the model memory back after five minutes of quiet. Speaking
then arrived with nothing loaded and was refused with "No voice is loaded" —
which reads as a lie, because the voice is downloaded and the setting is on.

The last voice asked for is now remembered across that release, and a passage
that finds nothing loaded is held while the voice comes back rather than
refused. Loading is not instant, so the passage waits for `ready`; if it never
comes, the passage fails by name instead of leaving the caller waiting for a
`done` that will never arrive.

A streaming answer opens its passage empty and fills it as the words arrive, so
sentences appended during that reload are held with it. Otherwise they would
reach a worker with no passage open and be dropped, and the answer would simply
be silent.

### Starting sooner: a short opening

A sentence is produced whole before any of it can be heard, so the opening
sentence sets the wait before an answer starts. A long opening is therefore
broken at a clause. Measured on the natural voice, through the real worker:

| Opening | First sound |
|---|---|
| 119 characters | 5.4 s |
| 84 characters | 4.1 s |
| 55 characters | 2.9 s |
| 33 characters | 1.8 s |

Shorter is not simply better. The natural voice produces speech at about the
speed of speech, so an opening much shorter than the piece behind it is heard
out before that piece is ready and the answer stalls in the middle — worse than
a longer wait at the start. Sixty characters is where the opening still covers
what follows.

Only the opening is shortened. Every later sentence is produced while the
previous one is still being heard, so its length costs nothing.

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
