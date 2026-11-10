import { describe, it, expect } from 'vitest'
import { flattenPanelScrollers, restorePanelScrollers } from './flatten-panel-scrollers'

function scroller(
  cls: string,
  dims: Partial<
    Record<'scrollHeight' | 'clientHeight' | 'scrollWidth' | 'clientWidth' | 'offsetWidth' | 'offsetHeight', number>
  >
): HTMLElement {
  const el = document.createElement('div')
  el.className = cls
  for (const [k, v] of Object.entries(dims)) Object.defineProperty(el, k, { value: v, configurable: true })
  return el
}

function setup(...children: HTMLElement[]): HTMLElement {
  const root = document.createElement('div')
  const panel = document.createElement('div')
  panel.setAttribute('data-canvas-panel', 'true')
  panel.append(...children)
  root.append(panel)
  document.body.append(root)
  return root
}

describe('flattenPanelScrollers', () => {
  it('hides overflowing panel scrollers and restores their previous inline styles', () => {
    const a = scroller('overflow-y-auto', { scrollHeight: 900, clientHeight: 300 })
    a.style.overflow = 'auto'
    const root = setup(a)
    const flat = flattenPanelScrollers(root)
    expect(flat).toHaveLength(1)
    expect(a.style.overflow).toBe('hidden')
    restorePanelScrollers(flat)
    expect(a.style.overflow).toBe('auto')
  })

  it('ignores scrollers outside canvas panels and ones without overflow', () => {
    const outside = scroller('overflow-y-auto', { scrollHeight: 900, clientHeight: 300 })
    const fits = scroller('overflow-auto', { scrollHeight: 100, clientHeight: 300, scrollWidth: 10, clientWidth: 20 })
    const root = setup(fits)
    root.append(outside)
    expect(flattenPanelScrollers(root)).toHaveLength(0)
    expect(outside.style.overflow).toBe('')
    expect(fits.style.overflow).toBe('')
  })

  it('keeps a classic vertical scrollbar gutter and skips scrollers with a horizontal scrollbar', () => {
    const vbar = scroller('overflow-y-auto', {
      scrollHeight: 900,
      clientHeight: 300,
      offsetHeight: 300,
      clientWidth: 285,
      offsetWidth: 300
    })
    const hbar = scroller('overflow-x-auto', {
      scrollWidth: 900,
      clientWidth: 300,
      offsetWidth: 300,
      clientHeight: 85,
      offsetHeight: 100
    })
    const root = setup(vbar, hbar)
    const flat = flattenPanelScrollers(root)
    expect(flat.map((f) => f.el)).toEqual([vbar])
    expect(vbar.style.scrollbarGutter).toBe('stable')
    expect(hbar.style.overflow).toBe('')
    restorePanelScrollers(flat)
    expect(vbar.style.scrollbarGutter).toBe('')
  })
})
