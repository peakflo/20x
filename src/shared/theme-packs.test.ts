import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME_PACK, THEME_PACKS, isLayoutChoice, isThemePackId, resolveHomeLayout } from './theme-packs'

const css = readFileSync(resolve(__dirname, '../renderer/src/styles/theme-packs.css'), 'utf8')

describe('theme packages', () => {
  it('keeps Legacy as the default', () => {
    expect(DEFAULT_THEME_PACK).toBe('legacy')
    expect(THEME_PACKS[0].id).toBe('legacy')
  })

  it('recognises only known packages', () => {
    expect(isThemePackId('calm')).toBe(true)
    expect(isThemePackId('legacy')).toBe(true)
    expect(isThemePackId('neon')).toBe(false)
    expect(isThemePackId(null)).toBe(false)
  })

  it('gives every package except Legacy a light and a dark block in the stylesheet', () => {
    for (const pack of THEME_PACKS.filter((p) => p.id !== 'legacy')) {
      expect(css).toContain(`:root[data-theme-pack="${pack.id}"] {`)
      expect(css).toContain(`:root.dark[data-theme-pack="${pack.id}"] {`)
    }
    expect(css).not.toContain('data-theme-pack="legacy"')
  })
})

describe('home layouts', () => {
  it('follows the package when it has its own home, else falls back to Legacy', () => {
    expect(resolveHomeLayout('legacy', 'match')).toBe('legacy')
    expect(resolveHomeLayout('calm', 'match')).toBe('calm')
    expect(resolveHomeLayout('mission', 'match')).toBe('legacy')
  })

  it('lets a fixed choice mix one package with another layout', () => {
    expect(resolveHomeLayout('mission', 'calm')).toBe('calm')
    expect(resolveHomeLayout('calm', 'legacy')).toBe('legacy')
  })

  it('accepts only known layout choices', () => {
    expect(isLayoutChoice('match')).toBe(true)
    expect(isLayoutChoice('peako')).toBe(true)
    expect(isLayoutChoice('grid')).toBe(false)
  })
})
