/**
 * Where dictated words go.
 *
 * Two problems shape this file.
 *
 * 1. The transcript panel is mounted many times at once — the task workspace,
 *    each canvas panel, and the Mastermind drawer. If every copy listened, one
 *    spoken sentence would appear in all of them. So there is exactly one
 *    active composer, and the microphone button that starts the turn names it.
 *
 * 2. A composer is replaced while a conversation is running. Starting an agent
 *    session swaps the whole panel, so the text field and the send function
 *    from the first mount are both dead. Holding a reference to them would make
 *    the conversation look as if it had stopped listening: it keeps hearing,
 *    but the words reach a field that is no longer on the page.
 *
 * So a composer is addressed by a stable **key**, not by an element. Each mount
 * registers under that key, and the field and the send function are resolved at
 * the moment a sentence arrives — always from the mount that is on screen now.
 */

/**
 * The Mastermind composer. Named here because two controls outside the drawer
 * address it: the top-bar microphone and the global shortcut.
 */
export const MASTERMIND_COMPOSER_KEY = 'orchestrator'

/** The dashboard command box. Named for the same reason. */
export const DASHBOARD_COMPOSER_KEY = 'dashboard-command'

/**
 * A transcript composer registers under its task ID, so the key names the task
 * a spoken sentence was sent to. The two composers above belong to no task and
 * send on their own behalf.
 */
/**
 * The Mastermind session's own id.
 *
 * It is a session like any other, so it can name itself. It used to name
 * nothing, and main then armed an expectation that matched the first answer
 * from ANY task — so speaking to the drawer made 20x read out whatever the
 * open task happened to write next.
 */
export const MASTERMIND_SESSION_ID = 'mastermind-session'

/**
 * Which session a composer speaks to.
 *
 * Both the drawer and the dashboard command box send to Mastermind, so both
 * name the Mastermind session. Everything else is a task, and its key is the
 * task id. Speech in and speech out are tied to one session either way.
 */
export function taskIdOfComposer(key: string | null): string | undefined {
  if (!key) return undefined
  if (key === MASTERMIND_COMPOSER_KEY || key === DASHBOARD_COMPOSER_KEY) return MASTERMIND_SESSION_ID
  return key
}

export type DictationTarget = HTMLTextAreaElement | HTMLInputElement

export interface ComposerRegistration {
  /** The live text field. Read at the moment a sentence arrives. */
  getField: () => DictationTarget | null
  /** Sends the composer. Present only where a conversation can send. */
  submit?: () => void
  /** Sends supplied text through the same live handler as the composer. */
  sendMessage?: (message: string) => void
}

const composers = new Map<string, ComposerRegistration>()
let activeKey: string | null = null

/** Fallback for a composer that has no key: a direct element and callback. */
let looseTarget: DictationTarget | null = null
let looseSubmit: (() => void) | null = null

/**
 * A composer announces itself for as long as it is mounted. A later mount with
 * the same key replaces the earlier one, which is what makes a conversation
 * survive the panel being rebuilt.
 */
export function registerComposer(key: string, registration: ComposerRegistration): () => void {
  composers.set(key, registration)
  return () => {
    // Only withdraw if this exact registration is still the current one.
    if (composers.get(key) === registration) composers.delete(key)
  }
}

/**
 * Whether that composer can send what is dictated into it.
 *
 * A control that is not inside a composer — the top-bar microphone — has to ask
 * before it offers the conversational loop, because it holds no send function
 * of its own.
 */
export function composerCanSubmit(key: string): boolean {
  return Boolean(composers.get(key)?.submit)
}

/** Sends text through the live composer without changing its draft. */
export function sendComposerMessage(key: string, message: string): boolean {
  const sendMessage = composers.get(key)?.sendMessage
  const text = message.trim()
  if (!sendMessage || !text) return false
  sendMessage(text)
  return true
}

/**
 * The composer the open turn is writing into, if it named one.
 *
 * Read by every microphone button, so the one beside that composer can show
 * that it is listening — even when the turn was started from somewhere else.
 */
export function getActiveComposer(): string | null {
  return activeKey
}

/** Names the composer that the open turn belongs to. */
export function setActiveComposer(key: string | null): void {
  activeKey = key
  looseTarget = null
  looseSubmit = null
}

/**
 * Direct form, for a composer that does not register a key.
 * Kept because it needs no cooperation from the component.
 */
export function setDictationTarget(element: DictationTarget | null, onSubmit?: () => void): void {
  activeKey = null
  looseTarget = element
  looseSubmit = onSubmit ?? null
}

export function clearDictationTarget(): void {
  activeKey = null
  looseTarget = null
  looseSubmit = null
  composers.clear()
}

/** Forgets which composer is active, but keeps the registrations. */
export function clearActiveComposer(): void {
  activeKey = null
  looseTarget = null
  looseSubmit = null
}

function current(): { field: DictationTarget | null; submit: (() => void) | null } {
  if (activeKey) {
    const registration = composers.get(activeKey)
    const field = registration?.getField() ?? null
    return { field: field?.isConnected ? field : null, submit: registration?.submit ?? null }
  }
  const field = looseTarget?.isConnected ? looseTarget : null
  return { field, submit: looseSubmit }
}

export function getDictationTarget(): DictationTarget | null {
  return current().field
}

/**
 * Finds the text field that belongs to a microphone button.
 * The composer marks itself with `data-voice-composer`.
 */
export function findComposerField(button: HTMLElement | null): DictationTarget | null {
  const composer = button?.closest<HTMLElement>('[data-voice-composer]')
  return composer?.querySelector<DictationTarget>('textarea, input[type="text"]') ?? null
}

/** Reads the key a microphone button belongs to, if its composer set one. */
export function findComposerKey(button: HTMLElement | null): string | null {
  const composer = button?.closest<HTMLElement>('[data-voice-composer]')
  const key = composer?.getAttribute('data-voice-composer')
  return key ? key : null
}

/**
 * Appends text to the active composer and tells React about it.
 *
 * React tracks the last value it wrote, so a plain assignment is ignored by a
 * controlled field. Writing through the prototype setter and then dispatching
 * `input` makes both controlled and uncontrolled fields update.
 *
 * Returns false when there is nothing to write to.
 */
export function insertDictation(text: string): boolean {
  const { field } = current()
  const words = text.trim()
  if (!field || !words) return false

  const separator = field.value && !/\s$/.test(field.value) ? ' ' : ''
  const next = `${field.value}${separator}${words}`

  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set
  if (setter) setter.call(field, next)
  else field.value = next

  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.focus()
  field.setSelectionRange(next.length, next.length)
  return true
}

/**
 * Writes one finished sentence and sends it.
 * Returns false when there is nothing to write to, or no way to send.
 */
export function insertAndSubmit(text: string): boolean {
  const { submit } = current()
  if (!submit) return false
  if (!insertDictation(text)) return false
  submit()
  return true
}
