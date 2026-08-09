import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearDictationTarget,
  findComposerField,
  insertDictation,
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
