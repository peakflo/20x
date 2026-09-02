import { describe, expect, it } from 'vitest'
import {
  dispatchTaskShortcut,
  getNextWhipMessage,
  isKeyboardInput,
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

  it('cycles through different Whip messages', () => {
    const first = getNextWhipMessage()
    const second = getNextWhipMessage()
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
})
