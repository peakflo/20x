import { describe, expect, it } from 'vitest'
import {
  PEAKO_MASCOT_SIZE,
  PEAKO_PANEL_SIZE,
  choosePeakoLayout,
  clampRect,
  defaultPeakoPosition,
  parsePeakoPosition,
  peakoMascotOrigin,
  peakoWindowBounds
} from './peako-window'
import { isPeakoCommand, normalizePeakoName, PEAKO_DEFAULT_NAME } from '../shared/peako'

const WORK_AREA = { x: 0, y: 0, width: 1440, height: 900 }

describe('Peako window geometry', () => {
  it('opens the chat to the right and upward from a mascot in the bottom-left', () => {
    const mascot = { x: 40, y: 700 }
    const layout = choosePeakoLayout(mascot, WORK_AREA)
    expect(layout).toEqual({ expanded: true, panelSide: 'right', mascotAtTop: false })
    const bounds = peakoWindowBounds(mascot, layout)
    expect(bounds.x).toBe(40)
    expect(bounds.y + bounds.height).toBe(mascot.y + PEAKO_MASCOT_SIZE.height)
  })

  it('opens the chat to the left from a mascot at the right edge', () => {
    const mascot = defaultPeakoPosition(WORK_AREA)
    const layout = choosePeakoLayout(mascot, WORK_AREA)
    expect(layout.panelSide).toBe('left')
    const bounds = peakoWindowBounds(mascot, layout)
    expect(bounds.x + bounds.width).toBe(mascot.x + PEAKO_MASCOT_SIZE.width)
  })

  it('hangs the chat below a mascot near the top of the screen', () => {
    expect(choosePeakoLayout({ x: 200, y: 20 }, WORK_AREA).mascotAtTop).toBe(true)
  })

  it('keeps the mascot where it was when the chat opens and closes', () => {
    const mascot = { x: 900, y: 600 }
    const layout = choosePeakoLayout(mascot, WORK_AREA)
    const expanded = peakoWindowBounds(mascot, layout)
    expect(peakoMascotOrigin(expanded, layout)).toEqual(mascot)
    expect(expanded.width).toBe(PEAKO_MASCOT_SIZE.width + PEAKO_PANEL_SIZE.width)
  })

  it('works on a second display with negative coordinates', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 }
    const mascot = defaultPeakoPosition(left)
    expect(mascot.x).toBeLessThan(0)
    const bounds = clampRect(peakoWindowBounds(mascot, choosePeakoLayout(mascot, left)), left)
    expect(bounds.x).toBeGreaterThanOrEqual(left.x)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(left.x + left.width)
  })

  it('pulls a window back onto the screen', () => {
    expect(clampRect({ x: 1400, y: -50, width: 132, height: 148 }, WORK_AREA)).toEqual({
      x: 1440 - 132,
      y: 0,
      width: 132,
      height: 148
    })
  })

  it('reads a saved position and ignores a corrupt one', () => {
    expect(parsePeakoPosition('{"x":10.4,"y":20}')).toEqual({ x: 10, y: 20 })
    expect(parsePeakoPosition('not json')).toBeNull()
    expect(parsePeakoPosition('{"x":"1","y":2}')).toBeNull()
    expect(parsePeakoPosition(undefined)).toBeNull()
  })
})

describe('Peako commands and names', () => {
  it('accepts well-formed commands', () => {
    expect(isPeakoCommand({ type: 'send', text: 'What is pending?' })).toBe(true)
    expect(isPeakoCommand({ type: 'approve', approved: false })).toBe(true)
    expect(isPeakoCommand({ type: 'setAgent', agentId: 'a1' })).toBe(true)
    expect(isPeakoCommand({ type: 'voice' })).toBe(true)
    expect(isPeakoCommand({ type: 'focusTask', taskId: 't1' })).toBe(true)
    expect(isPeakoCommand({ type: 'focusTask', taskId: null })).toBe(true)
    expect(isPeakoCommand({ type: 'taskSend', taskId: 't1', text: 'Use the staging DB' })).toBe(true)
    expect(isPeakoCommand({ type: 'taskApprove', taskId: 't1', approved: true })).toBe(true)
    expect(isPeakoCommand({ type: 'taskStop', taskId: 't1' })).toBe(true)
    expect(isPeakoCommand({ type: 'openTask', taskId: 't1' })).toBe(true)
  })

  it('refuses task commands without a task or a message', () => {
    expect(isPeakoCommand({ type: 'focusTask' })).toBe(false)
    expect(isPeakoCommand({ type: 'taskSend', taskId: 't1', text: ' ' })).toBe(false)
    expect(isPeakoCommand({ type: 'taskSend', taskId: '', text: 'hi' })).toBe(false)
    expect(isPeakoCommand({ type: 'taskApprove', taskId: 't1' })).toBe(false)
    expect(isPeakoCommand({ type: 'openTask', taskId: 7 })).toBe(false)
  })

  it('refuses anything off-schema', () => {
    expect(isPeakoCommand(null)).toBe(false)
    expect(isPeakoCommand({ type: 'runShell', command: 'rm -rf /' })).toBe(false)
    expect(isPeakoCommand({ type: 'send', text: '   ' })).toBe(false)
    expect(isPeakoCommand({ type: 'send', text: 42 })).toBe(false)
    expect(isPeakoCommand({ type: 'approve', approved: 'yes' })).toBe(false)
    expect(isPeakoCommand({ type: 'setAgent', agentId: '' })).toBe(false)
  })

  it('tidies names and falls back to the default', () => {
    expect(normalizePeakoName('  Captain   Peako ')).toBe('Captain Peako')
    expect(normalizePeakoName('')).toBe(PEAKO_DEFAULT_NAME)
    expect(normalizePeakoName(null)).toBe(PEAKO_DEFAULT_NAME)
    expect(normalizePeakoName('x'.repeat(40))).toHaveLength(24)
  })
})
