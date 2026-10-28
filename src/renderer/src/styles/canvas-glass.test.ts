import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Keep the gesture performance fallback, but never leave idle glass unblurred.
describe('canvas panel glass', () => {
  const css = readFileSync(join(__dirname, 'globals.css'), 'utf8')
  const motionRule = css.match(/:is\(\[data-canvas-gesturing\][^{]+\{([^}]*)\}/)!

  it('uses an opaque fill when motion disables blur', () => {
    expect(motionRule).toBeTruthy()
    expect(motionRule[1]).toContain('background: var(--glass-solid)')
    expect(motionRule[1]).toContain('-webkit-backdrop-filter: none')
    expect(motionRule[1]).toMatch(/(^|[^-])backdrop-filter: none/)
    expect(motionRule[0]).toContain('[data-canvas-moving="true"]')
    expect(css).not.toMatch(/^\[data-canvas-panel\] .*backdrop-filter: none/m)
  })

  it('freezes every glass surface, including composer pseudo-elements', () => {
    const blurred = css.match(/^\.glass-task-detail-bar, ([^{]*)\{\s*border-color: var\(--glass-outline\);\s*-webkit-backdrop-filter/m)!
    expect(blurred).toBeTruthy()
    for (const cls of blurred[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      expect(motionRule[0]).toContain(cls)
    }
    expect(motionRule[0]).toContain('.glass-todo-summary')
    expect(motionRule[0]).toContain('.glass-composer::before')
  })
})
