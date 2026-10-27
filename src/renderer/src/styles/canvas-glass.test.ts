import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Each backdrop-filter inside a canvas panel is a blur pass that the
// compositor redoes on every pan/zoom frame. In a real Electron window
// (scripts/perf/canvas-gesture-bench) 20 task panels dropped zoom from
// ~117 fps to ~18 fps with them. Keep them switched off inside panels.
describe('canvas panel glass', () => {
  const css = readFileSync(join(__dirname, 'globals.css'), 'utf8')

  it('turns off backdrop-filter for every glass surface inside a canvas panel', () => {
    const rule = css.match(/\[data-canvas-panel\] :is\(([^)]*)\),\s*\[data-canvas-panel\] \.glass-composer::before \{([^}]*)\}/)
    expect(rule).toBeTruthy()
    const [, selectors, body] = rule!
    for (const cls of ['glass-task-detail-bar', 'glass-control', 'glass-action', 'glass-todo-summary', 'glass-attachment-chip', 'glass-popover']) {
      expect(selectors).toContain(`.${cls}`)
    }
    expect(body).toContain('-webkit-backdrop-filter: none')
    expect(body).toMatch(/(^|[^-])backdrop-filter: none/)
  })

  it('covers every glass class that sets a backdrop-filter', () => {
    const blurred = css.match(/^\.glass-task-detail-bar, ([^{]*)\{\s*border-color: var\(--glass-outline\);\s*-webkit-backdrop-filter/m)
    expect(blurred).toBeTruthy()
    const rule = css.match(/\[data-canvas-panel\] :is\(([^)]*)\)/)!
    for (const cls of blurred![1].split(',').map((s) => s.trim()).filter(Boolean)) {
      expect(rule[1]).toContain(cls)
    }
  })
})
