import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clearDictationTarget,
  findComposerField,
  findComposerKey,
  insertAndSubmit,
  insertDictation,
  registerComposer,
  setActiveComposer,
  setDictationTarget,
} from './voice-dictation-target'

/**
 * The transcript panel is mounted many times at once — the task workspace, each
 * canvas panel, and the Mastermind drawer. These tests pin the rule that one
 * spoken sentence reaches exactly one field.
 */

function composer(id: string): { root: HTMLElement; field: HTMLTextAreaElement; button: HTMLElement } {
  const root = document.createElement('div')
  root.setAttribute('data-voice-composer', '')
  root.id = id
  const field = document.createElement('textarea')
  const button = document.createElement('button')
  root.append(field, button)
  document.body.append(root)
  return { root, field, button }
}

beforeEach(() => {
  document.body.innerHTML = ''
  clearDictationTarget()
})

describe('findComposerField', () => {
  it('finds the field beside the button', () => {
    const a = composer('a')
    expect(findComposerField(a.button)).toBe(a.field)
  })

  it('never reaches into another composer', () => {
    const a = composer('a')
    composer('b')
    expect(findComposerField(a.button)).toBe(a.field)
  })

  it('returns nothing for a button outside a composer', () => {
    const loose = document.createElement('button')
    document.body.append(loose)
    expect(findComposerField(loose)).toBeNull()
  })
})

describe('insertDictation', () => {
  it('writes into one field only, never into every mounted panel', () => {
    const a = composer('a')
    const b = composer('b')
    const mastermind = composer('mastermind')

    setDictationTarget(a.field)
    expect(insertDictation('fix the login page')).toBe(true)

    expect(a.field.value).toBe('fix the login page')
    expect(b.field.value).toBe('')
    expect(mastermind.field.value).toBe('')
  })

  it('writes nowhere when no field was claimed', () => {
    const a = composer('a')
    expect(insertDictation('fix the login page')).toBe(false)
    expect(a.field.value).toBe('')
  })

  it('adds a space before the new words', () => {
    const a = composer('a')
    a.field.value = 'first'
    setDictationTarget(a.field)
    insertDictation('second')
    expect(a.field.value).toBe('first second')
  })

  it('tells React about the change', () => {
    const a = composer('a')
    let events = 0
    a.field.addEventListener('input', () => {
      events += 1
    })
    setDictationTarget(a.field)
    insertDictation('hello')
    expect(events).toBe(1)
  })

  it('drops a field that left the page', () => {
    const a = composer('a')
    setDictationTarget(a.field)
    a.root.remove()
    expect(insertDictation('hello')).toBe(false)
  })

  it('writes nothing for empty speech', () => {
    const a = composer('a')
    setDictationTarget(a.field)
    expect(insertDictation('   ')).toBe(false)
    expect(a.field.value).toBe('')
  })
})

describe('insertAndSubmit — the conversational loop', () => {
  it('writes the sentence and sends it', () => {
    const a = composer('a')
    const submit = vi.fn()
    setDictationTarget(a.field, submit)

    expect(insertAndSubmit('what broke the build')).toBe(true)
    expect(a.field.value).toBe('what broke the build')
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('sends each sentence separately, so the loop can continue', () => {
    const a = composer('a')
    const submit = vi.fn(() => {
      // The composer clears itself when it sends.
      a.field.value = ''
    })
    setDictationTarget(a.field, submit)

    insertAndSubmit('first sentence')
    insertAndSubmit('second sentence')

    expect(submit).toHaveBeenCalledTimes(2)
    expect(a.field.value).toBe('')
  })

  it('sends nothing when the composer cannot send', () => {
    const a = composer('a')
    setDictationTarget(a.field) // no submit — plain dictation

    expect(insertAndSubmit('hello')).toBe(false)
    expect(a.field.value).toBe('')
  })

  it('sends nothing into another panel', () => {
    const a = composer('a')
    const b = composer('b')
    const submit = vi.fn()
    setDictationTarget(a.field, submit)

    insertAndSubmit('one sentence')

    expect(b.field.value).toBe('')
  })
})

describe('a conversation survives the panel being rebuilt', () => {
  // Starting an agent session swaps the whole transcript panel. The old field
  // and the old send function are then dead. A conversation must carry on into
  // the panel that replaced it, or it looks as if it stopped listening.
  it('writes into the panel that replaced the first one', () => {
    const first = composer('first')
    const firstSubmit = vi.fn()
    const unregisterFirst = registerComposer('task-1', {
      getField: () => first.field,
      submit: firstSubmit,
    })
    setActiveComposer('task-1')

    expect(insertAndSubmit('first sentence')).toBe(true)
    expect(first.field.value).toBe('first sentence')

    // The session starts: the panel is torn down and built again.
    unregisterFirst()
    first.root.remove()
    const second = composer('second')
    const secondSubmit = vi.fn()
    registerComposer('task-1', { getField: () => second.field, submit: secondSubmit })

    expect(insertAndSubmit('second sentence')).toBe(true)
    expect(second.field.value).toBe('second sentence')
    expect(secondSubmit).toHaveBeenCalledTimes(1)
    // The dead panel receives nothing more.
    expect(firstSubmit).toHaveBeenCalledTimes(1)
  })

  it('always uses the send function of the current render', () => {
    const a = composer('a')
    let latest = vi.fn()
    registerComposer('task-1', { getField: () => a.field, submit: () => latest() })
    setActiveComposer('task-1')

    const stale = latest
    latest = vi.fn() // the component re-rendered with a new callback

    insertAndSubmit('a sentence')

    expect(latest).toHaveBeenCalledTimes(1)
    expect(stale).not.toHaveBeenCalled()
  })

  it('still writes to one composer only', () => {
    const mine = composer('mine')
    const other = composer('other')
    registerComposer('task-1', { getField: () => mine.field, submit: vi.fn() })
    registerComposer('task-2', { getField: () => other.field, submit: vi.fn() })
    setActiveComposer('task-1')

    insertAndSubmit('one sentence')

    expect(mine.field.value).toBe('one sentence')
    expect(other.field.value).toBe('')
  })

  it('reads the key a button belongs to', () => {
    const a = composer('a')
    a.root.setAttribute('data-voice-composer', 'task-9')
    expect(findComposerKey(a.button)).toBe('task-9')
  })
})
