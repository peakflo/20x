import { describe, expect, it } from 'vitest'
import {
  dispatchTaskShortcut,
  getNextNudgeMessage,
  isGlobalShortcutBlocked,
  isKeyboardInput,
  KEYBOARD_SHORTCUT_GROUPS,
  onTaskShortcut,
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
})
