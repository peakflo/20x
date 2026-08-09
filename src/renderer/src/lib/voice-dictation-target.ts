/**
 * Where dictated words go.
 *
 * The transcript panel is mounted many times at once — the task workspace, each
 * canvas panel, and the Mastermind drawer all render one. If every copy
 * listened for dictation, one spoken sentence would appear in all of them. So
 * there is exactly one target at a time, and the microphone button that started
 * the turn sets it.
 *
 * When no target is set — a turn started from the global shortcut, or the test
 * button in settings — nothing is inserted anywhere.
 */

export type DictationTarget = HTMLTextAreaElement | HTMLInputElement

let target: DictationTarget | null = null
let submit: (() => void) | null = null

/**
 * Called by the microphone button that starts a turn. `onSubmit` is supplied
 * only for a conversation, where each finished sentence is sent at once.
 */
export function setDictationTarget(element: DictationTarget | null, onSubmit?: () => void): void {
  target = element
  submit = onSubmit ?? null
}

export function getDictationTarget(): DictationTarget | null {
  // A field that left the document cannot receive anything.
  if (target && !target.isConnected) target = null
  return target
}

export function clearDictationTarget(): void {
  target = null
  submit = null
}

/**
 * Writes one finished sentence and sends it.
 * Returns false when there is nothing to write to, or no way to send.
 */
export function insertAndSubmit(text: string): boolean {
  if (!submit) return false
  if (!insertDictation(text)) return false
  submit()
  return true
}

/**
 * Finds the text field that belongs to a microphone button.
 * The composer marks itself with `data-voice-composer`.
 */
export function findComposerField(button: HTMLElement | null): DictationTarget | null {
  const composer = button?.closest<HTMLElement>('[data-voice-composer]')
  return composer?.querySelector<DictationTarget>('textarea, input[type="text"]') ?? null
}

/**
 * Appends text to the current target and tells React about it.
 *
 * React tracks the last value it wrote, so a plain assignment is ignored by a
 * controlled field. Writing through the prototype setter and then dispatching
 * `input` makes both controlled and uncontrolled fields update.
 *
 * Returns false when there is nothing to write to.
 */
export function insertDictation(text: string): boolean {
  const element = getDictationTarget()
  const words = text.trim()
  if (!element || !words) return false

  const separator = element.value && !/\s$/.test(element.value) ? ' ' : ''
  const next = `${element.value}${separator}${words}`

  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set
  if (setter) setter.call(element, next)
  else element.value = next

  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.focus()
  element.setSelectionRange(next.length, next.length)
  return true
}
