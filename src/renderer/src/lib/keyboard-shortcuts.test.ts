import { describe, expect, it } from 'vitest'
import {
  CHORD_TIMEOUT_MS,
  createChordTracker,
  dispatchTaskShortcut,
  findComposerElement,
  focusComposerInput,
  getChordCommand,
  getNextNudgeMessage,
  getShortcutKey,
  insertIntoComposer,
  isGlobalShortcutBlocked,
  isKeyboardInput,
  isModifierKeyEvent,
  isPrintableKey,
  KEYBOARD_SHORTCUT_GROUPS,
  onTaskShortcut,
  shouldAutoFocusComposer,
  TaskShortcutAction
} from './keyboard-shortcuts'

describe('getShortcutKey', () => {
  it('lower-cases the typed letter, including with Shift', () => {
    expect(getShortcutKey({ key: 'O', code: 'KeyO' })).toBe('o')
    expect(getShortcutKey({ key: 'r', code: 'KeyR' })).toBe('r')
  })

  it('falls back to the physical key when the layout types a non-Latin letter', () => {
    expect(getShortcutKey({ key: 'щ', code: 'KeyO' })).toBe('o')
    expect(getShortcutKey({ key: 'к', code: 'KeyR' })).toBe('r')
  })

  it('keeps punctuation and digits from the typed key', () => {
    expect(getShortcutKey({ key: '#', code: 'Digit3' })).toBe('#')
    expect(getShortcutKey({ key: '?', code: 'Slash' })).toBe('?')
    expect(getShortcutKey({ key: '2', code: 'Digit2' })).toBe('2')
  })

  it('returns an empty key for modifier-only and other non-printable keys', () => {
    expect(getShortcutKey({ key: 'Shift', code: 'ShiftLeft' })).toBe('')
    expect(getShortcutKey({ key: 'Escape', code: 'Escape' })).toBe('')
    expect(isModifierKeyEvent({ key: 'Meta' })).toBe(true)
    expect(isModifierKeyEvent({ key: 'o' })).toBe(false)
  })
})

describe('chord tracker', () => {
  it('completes a chord within the timeout', () => {
    let now = 0
    const chords = createChordTracker(() => now)
    chords.start('o')
    now = CHORD_TIMEOUT_MS
    expect(chords.isPending()).toBe(true)
    expect(chords.complete('s')).toEqual({ type: 'subtasks' })
    expect(chords.isPending()).toBe(false)
  })

  it('expires a pending chord after the timeout', () => {
    let now = 0
    const chords = createChordTracker(() => now)
    chords.start('o')
    now = CHORD_TIMEOUT_MS + 1
    expect(chords.isPending()).toBe(false)
    expect(chords.complete('s')).toBeNull()
  })

  it('keeps a pending chord across unrelated work, since state is not re-created', () => {
    // Regression: the old effect cleared its timer on re-subscription but left the
    // pending chord set, so the next key was swallowed forever.
    let now = 0
    const chords = createChordTracker(() => now)
    chords.start('o')
    now = 300
    expect(chords.isPending()).toBe(true)
    expect(chords.complete('d')).toEqual({ type: 'task', action: TaskShortcutAction.OPEN_DETAILS })
    expect(chords.isPending()).toBe(false)
  })

  it('consumes the pending chord on a non-matching key without leaving it armed', () => {
    const chords = createChordTracker(() => 0)
    chords.start('o')
    expect(chords.complete('x')).toBeNull()
    expect(chords.isPending()).toBe(false)
  })

  it('starting a new chord replaces the pending one and restarts the timer', () => {
    let now = 0
    const chords = createChordTracker(() => now)
    chords.start('g')
    now = 1000
    chords.start('o')
    now = 1000 + CHORD_TIMEOUT_MS - 1
    expect(chords.complete('p')).toEqual({ type: 'task', action: TaskShortcutAction.OPEN_PR })
  })

  it('cancel drops a pending chord', () => {
    const chords = createChordTracker(() => 0)
    chords.start('y')
    chords.cancel()
    expect(chords.complete('p')).toBeNull()
  })
})

describe('O and other chord commands', () => {
  it.each([
    ['d', { type: 'task', action: TaskShortcutAction.OPEN_DETAILS }],
    ['c', { type: 'task', action: TaskShortcutAction.OPEN_CHANGES }],
    ['o', { type: 'task', action: TaskShortcutAction.OPEN_OUTPUT }],
    ['a', { type: 'task', action: TaskShortcutAction.OPEN_ARTIFACT }],
    ['p', { type: 'task', action: TaskShortcutAction.OPEN_PR }],
    ['s', { type: 'subtasks' }]
  ] as const)('O %s is wired', (second, command) => {
    expect(getChordCommand('o', second)).toEqual(command)
  })

  it('treats the second key case-insensitively', () => {
    expect(getChordCommand('O', 'S')).toEqual({ type: 'subtasks' })
  })

  it('keeps G, Y and V chords routed', () => {
    expect(getChordCommand('g', 'd')).toEqual({ type: 'view', view: 'dashboard' })
    expect(getChordCommand('y', 'p')).toEqual({ type: 'task', action: TaskShortcutAction.COPY_PR_URL })
    expect(getChordCommand('v', 'm')).toEqual({ type: 'mastermindAudio' })
  })
})

describe('keyboard shortcuts', () => {
  it('blocks shortcuts in fields and editable content', () => {
    expect(isKeyboardInput(document.createElement('input'))).toBe(true)
    expect(isKeyboardInput(document.createElement('textarea'))).toBe(true)
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    expect(isKeyboardInput(editable)).toBe(true)
    expect(isKeyboardInput(document.createElement('div'))).toBe(false)
  })

  it('blocks a key event that a popup already handled', () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    event.preventDefault()

    expect(isGlobalShortcutBlocked(event)).toBe(true)
  })

  it('lets a pending chord finish after focus moves to an input, but still respects dialogs', () => {
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    const secondKey = new KeyboardEvent('keydown', { key: 's', bubbles: true })
    input.dispatchEvent(secondKey)
    expect(isGlobalShortcutBlocked(secondKey)).toBe(true)
    expect(isGlobalShortcutBlocked(secondKey, true)).toBe(false)

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    expect(isGlobalShortcutBlocked(secondKey, true)).toBe(true)
    dialog.remove()
    input.remove()
  })

  it('cycles through different Nudge messages', () => {
    const first = getNextNudgeMessage()
    const second = getNextNudgeMessage()
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThan(10)
    expect(second.length).toBeGreaterThan(10)
  })

  it('sends task shortcut events to subscribers', () => {
    let received: { action: TaskShortcutAction; taskId: string } | undefined
    const unsubscribe = onTaskShortcut((detail) => { received = detail })
    dispatchTaskShortcut({ action: TaskShortcutAction.OPEN_DETAILS, taskId: 'task-1' })
    unsubscribe()
    expect(received).toEqual({ action: TaskShortcutAction.OPEN_DETAILS, taskId: 'task-1' })
  })

  it('lists the task navigation and heartbeat shortcuts', () => {
    const shortcuts = KEYBOARD_SHORTCUT_GROUPS.reduce<Array<{ keys: readonly string[]; label: string }>>(
      (all, group) => [...all, ...group.shortcuts],
      []
    )
    expect(shortcuts).toEqual(expect.arrayContaining([
      expect.objectContaining({ keys: ['O', 'S'], label: 'Choose a subtask to open' }),
      expect.objectContaining({ keys: ['G', 'P'], label: 'Go to parent task' }),
      expect.objectContaining({ keys: ['G', 'C'], label: 'Open selected task on Canvas or go to Canvas' }),
      expect.objectContaining({ keys: ['Shift', 'H'], label: 'Run heartbeat now' })
    ]))
  })

  it('routes the related navigation chords', () => {
    expect(getChordCommand('G', 'P')).toEqual({ type: 'parent' })
    expect(getChordCommand('g', 'c')).toEqual({ type: 'canvas' })
    expect(getChordCommand('O', 'S')).toEqual({ type: 'subtasks' })
  })

  it('lists the focus composer shortcuts', () => {
    const shortcuts = KEYBOARD_SHORTCUT_GROUPS.reduce<Array<{ keys: readonly string[]; label: string }>>(
      (all, group) => [...all, ...group.shortcuts],
      []
    )
    expect(shortcuts).toEqual(expect.arrayContaining([
      expect.objectContaining({ keys: ['I'], label: 'Focus message composer' }),
      expect.objectContaining({ keys: ['Type'], label: 'Just start typing to focus composer' })
    ]))
  })

  it('focuses the composer textarea when present', () => {
    const textarea = document.createElement('textarea')
    textarea.setAttribute('placeholder', 'Write a message...')
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-testid', 'transcript-composer')
    wrapper.appendChild(textarea)
    document.body.appendChild(wrapper)
    // jsdom offsetParent is null by default; simulate visible
    Object.defineProperty(textarea, 'offsetParent', { get: () => wrapper, configurable: true })

    expect(findComposerElement()).toBe(textarea)
    expect(focusComposerInput()).toBe(true)
    expect(document.activeElement).toBe(textarea)

    document.body.removeChild(wrapper)
  })

  it('prefers the composer inside the selected canvas panel', () => {
    // A visible composer outside the panel — matched only if the selected
    // panel preference fails
    const outsideTextarea = document.createElement('textarea')
    outsideTextarea.setAttribute('placeholder', 'Write a message...')
    const outsideWrapper = document.createElement('div')
    outsideWrapper.setAttribute('data-testid', 'transcript-composer')
    outsideWrapper.appendChild(outsideTextarea)
    document.body.appendChild(outsideWrapper)
    Object.defineProperty(outsideTextarea, 'offsetParent', { get: () => outsideWrapper, configurable: true })

    // The composer of the selected canvas panel
    const selectedPanel = document.createElement('div')
    selectedPanel.setAttribute('data-canvas-panel-selected', 'true')
    const panelComposer = document.createElement('div')
    panelComposer.setAttribute('data-testid', 'transcript-composer')
    const panelTextarea = document.createElement('textarea')
    panelTextarea.setAttribute('placeholder', 'Write a message...')
    panelComposer.appendChild(panelTextarea)
    selectedPanel.appendChild(panelComposer)
    document.body.appendChild(selectedPanel)
    Object.defineProperty(panelTextarea, 'offsetParent', { get: () => panelComposer, configurable: true })

    expect(findComposerElement()).toBe(panelTextarea)

    document.body.removeChild(outsideWrapper)
    document.body.removeChild(selectedPanel)
  })

  it('skips hidden composers and finds the visible one', () => {
    // A hidden composer (e.g. inside a visibility:hidden canvas) must be skipped
    const hiddenTextarea = document.createElement('textarea')
    hiddenTextarea.setAttribute('placeholder', 'Write a message...')
    const hiddenWrapper = document.createElement('div')
    hiddenWrapper.setAttribute('data-testid', 'transcript-composer')
    hiddenWrapper.appendChild(hiddenTextarea)
    document.body.appendChild(hiddenWrapper)
    Object.defineProperty(hiddenTextarea, 'offsetParent', { get: () => hiddenWrapper, configurable: true })
    hiddenTextarea.style.visibility = 'hidden'

    // The visible one further down the document
    const visibleTextarea = document.createElement('textarea')
    visibleTextarea.setAttribute('placeholder', 'Write a message...')
    const visibleWrapper = document.createElement('div')
    visibleWrapper.setAttribute('data-testid', 'transcript-composer')
    visibleWrapper.appendChild(visibleTextarea)
    document.body.appendChild(visibleWrapper)
    Object.defineProperty(visibleTextarea, 'offsetParent', { get: () => visibleWrapper, configurable: true })

    expect(findComposerElement()).toBe(visibleTextarea)

    document.body.removeChild(hiddenWrapper)
    document.body.removeChild(visibleWrapper)
  })

  it('detects printable keys for auto-focus', () => {
    expect(isPrintableKey(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true)
    expect(isPrintableKey(new KeyboardEvent('keydown', { key: 'A' }))).toBe(true)
    expect(isPrintableKey(new KeyboardEvent('keydown', { key: '1' }))).toBe(true)
    expect(isPrintableKey(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
    expect(isPrintableKey(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false)
    expect(isPrintableKey(new KeyboardEvent('keydown', { key: 'a', metaKey: true }))).toBe(false)
    expect(isPrintableKey(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))).toBe(false)
  })

  it('does not auto-focus on shortcut keys but does on other printable keys', () => {
    const textarea = document.createElement('textarea')
    textarea.setAttribute('placeholder', 'Write a message...')
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-testid', 'transcript-composer')
    wrapper.appendChild(textarea)
    document.body.appendChild(wrapper)
    Object.defineProperty(textarea, 'offsetParent', { get: () => wrapper, configurable: true })

    // Shortcut keys should not auto-focus
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: 'c' }))).toBe(false)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: 'j' }))).toBe(false)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: '/' }))).toBe(false)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: 'g' }))).toBe(false)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: 'r' }))).toBe(false)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: 'R', shiftKey: true }))).toBe(false)
    // Non-shortcut printable keys should auto-focus
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: 'z' }))).toBe(true)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: '1' }))).toBe(true)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: '.' }))).toBe(true)
    // The second key of a pending chord must never enter the composer.
    for (const key of ['p', 'c', 's']) {
      expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key }), true)).toBe(false)
    }

    document.body.removeChild(wrapper)
  })

  it('inserts text into the composer at cursor', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'hello'
    textarea.setSelectionRange(5, 5)
    insertIntoComposer(textarea, '!')
    expect(textarea.value).toBe('hello!')
    expect(textarea.selectionStart).toBe(6)
  })

  it('blocks auto-focus when typing in an input', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true })
    Object.defineProperty(event, 'target', { value: input })
    expect(shouldAutoFocusComposer(event)).toBe(false)
    document.body.removeChild(input)
  })
})
