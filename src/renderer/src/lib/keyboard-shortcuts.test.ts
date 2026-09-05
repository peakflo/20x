import { describe, expect, it } from 'vitest'
import {
  dispatchTaskShortcut,
  findComposerElement,
  focusComposerInput,
  getNextNudgeMessage,
  insertIntoComposer,
  isGlobalShortcutBlocked,
  isKeyboardInput,
  isPrintableKey,
  KEYBOARD_SHORTCUT_GROUPS,
  onTaskShortcut,
  shouldAutoFocusComposer,
  TaskShortcutAction
} from './keyboard-shortcuts'

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
    // Non-shortcut printable keys should auto-focus
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: 'z' }))).toBe(true)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: '1' }))).toBe(true)
    expect(shouldAutoFocusComposer(new KeyboardEvent('keydown', { key: '.' }))).toBe(true)

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
