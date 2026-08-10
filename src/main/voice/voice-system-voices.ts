/**
 * The voices the operating system already has.
 *
 * This is the half of the hybrid design that costs nothing: no download, no
 * local runtime, no model licence to review. It is what makes spoken answers
 * work on the day a user installs 20x, and it is the fallback whenever the
 * neural model is not present.
 *
 * Enumeration lives in main rather than in the worker, because the settings
 * page needs the list even when nothing is being spoken.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { VoiceTtsVoice } from '../../shared/voice-tts'

const run = promisify(execFile)

/** Listing must never hold a settings page open. */
const LIST_TIMEOUT_MS = 8000

export function systemVoiceId(name: string): string {
  return `system:${name}`
}

/** The operating-system voice name inside a `system:` voice ID. */
export function systemVoiceName(voiceId: string): string {
  return voiceId.startsWith('system:') ? voiceId.slice('system:'.length) : ''
}

/**
 * Lists the installed voices, best guess first.
 *
 * A failure is never thrown. An empty list simply means the system engine is
 * not offered, and the settings page says so.
 */
export async function listSystemVoices(platform = process.platform): Promise<VoiceTtsVoice[]> {
  try {
    if (platform === 'darwin') return sortForEnglish(parseSayVoices(await sayList()))
    if (platform === 'win32') return sortForEnglish(parseWindowsVoices(await windowsList()))
    if (platform === 'linux') return sortForEnglish(parseEspeakVoices(await espeakList()))
  } catch {
    /* no system voice on this machine */
  }
  return []
}

async function sayList(): Promise<string> {
  const { stdout } = await run('say', ['-v', '?'], { timeout: LIST_TIMEOUT_MS })
  return stdout
}

async function windowsList(): Promise<string> {
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    "$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name + '|' + $_.VoiceInfo.Gender };",
    '$s.Dispose();',
  ].join(' ')
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: LIST_TIMEOUT_MS,
    windowsHide: true,
  })
  return stdout
}

async function espeakList(): Promise<string> {
  const { stdout } = await run('espeak-ng', ['--voices'], { timeout: LIST_TIMEOUT_MS })
  return stdout
}

// ── Parsers (exported so they can be tested without the machine) ──

/** `Samantha            en_US    # Hello! My name is Samantha.` */
export function parseSayVoices(stdout: string): VoiceTtsVoice[] {
  const voices: VoiceTtsVoice[] = []
  for (const line of stdout.split(/\r?\n/)) {
    // The name may hold spaces and brackets — "Eddy (English (UK))" is a real
    // one — and it is padded to a column, so a long name leaves only a single
    // space before the language tag. The line is therefore read from its end:
    // the sample after `#` and the language tag before it are the fixed parts.
    const match = /^(.+?)\s+([A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,4})?)\s+#\s?(.*)$/.exec(line)
    if (!match) continue
    const [, name, language, sample] = match
    voices.push({
      id: systemVoiceId(name.trim()),
      label: name.trim(),
      engine: 'system',
      speakerId: 0,
      modelId: '',
      language: language.replace('_', '-'),
      description: (sample ?? '').trim(),
    })
  }
  return voices
}

/** `Microsoft Zira Desktop|en-US|Female` */
export function parseWindowsVoices(stdout: string): VoiceTtsVoice[] {
  const voices: VoiceTtsVoice[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split('|')
    if (parts.length < 2 || !parts[0]) continue
    voices.push({
      id: systemVoiceId(parts[0]),
      label: parts[0],
      engine: 'system',
      speakerId: 0,
      modelId: '',
      language: parts[1] || 'en',
      description: parts[2] ? `${parts[2]}.` : '',
    })
  }
  return voices
}

/** ` 5  en-gb          --/M      English (Great Britain)  gmw/en  ` */
export function parseEspeakVoices(stdout: string): VoiceTtsVoice[] {
  const voices: VoiceTtsVoice[] = []
  const lines = stdout.split(/\r?\n/)
  for (const line of lines) {
    if (/^\s*Pty\b/.test(line)) continue
    const match = /^\s*\d+\s+(\S+)\s+(\S+)\s+(.+?)\s{2,}(\S+)/.exec(line)
    if (!match) continue
    const [, language, , name] = match
    voices.push({
      id: systemVoiceId(language),
      label: name.trim(),
      engine: 'system',
      speakerId: 0,
      modelId: '',
      language,
      description: '',
    })
  }
  return voices
}

/**
 * English first, then everything else by name.
 *
 * 20x speaks English, so a list that opens on an Arabic or a Swedish voice
 * looks broken even though nothing is wrong.
 */
function sortForEnglish(voices: VoiceTtsVoice[]): VoiceTtsVoice[] {
  return [...voices].sort((a, b) => {
    const aEnglish = a.language.toLowerCase().startsWith('en')
    const bEnglish = b.language.toLowerCase().startsWith('en')
    if (aEnglish !== bEnglish) return aEnglish ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

/** The voice used when the user has never picked one. */
export function pickDefaultSystemVoice(voices: VoiceTtsVoice[]): VoiceTtsVoice | null {
  if (voices.length === 0) return null
  const english = voices.filter((voice) => voice.language.toLowerCase().startsWith('en'))
  return english[0] ?? voices[0]
}
