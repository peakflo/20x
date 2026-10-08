/**
 * Theme packages restyle the whole app through the design tokens in
 * globals.css: colours, fonts, corner shapes and depth, each in light and
 * dark. "Legacy" is the look 20x has always had and stays the default.
 */

export type ThemePackId = 'legacy' | 'calm' | 'mission' | 'peako'

export const THEME_PACK_STORAGE_KEY = 'ui-theme-pack'
export const DEFAULT_THEME_PACK: ThemePackId = 'legacy'

export interface ThemePackInfo {
  id: ThemePackId
  name: string
  description: string
  /** Background, surface and accent, for the picker's preview. */
  swatches: { light: [string, string, string]; dark: [string, string, string] }
}

export const THEME_PACKS: ThemePackInfo[] = [
  {
    id: 'legacy',
    name: 'Legacy',
    description: 'The classic 20x look.',
    swatches: { light: ['#f4f4f5', '#ffffff', '#1e96eb'], dark: ['#141414', '#1e1e1e', '#1e96eb'] }
  },
  {
    id: 'calm',
    name: 'Calm Desk',
    description: 'Light and airy, soft surfaces, roomy type.',
    swatches: { light: ['#f6f7f9', '#ffffff', '#1668b0'], dark: ['#111418', '#1a1e24', '#5aa9f0'] }
  },
  {
    id: 'mission',
    name: 'Mission Control',
    description: 'Dense and technical, sharp corners, monospace details.',
    swatches: { light: ['#f3f5f8', '#ffffff', '#0a6fc2'], dark: ['#0b0e13', '#10161d', '#3fa9f5'] }
  },
  {
    id: 'peako',
    name: 'Peako World',
    description: 'Playful and rounded, chunky shadows, friendly type.',
    swatches: { light: ['#e9f2fd', '#ffffff', '#1770c2'], dark: ['#0e1b2c', '#15263b', '#5fb0ff'] }
  }
]

export function isThemePackId(value: unknown): value is ThemePackId {
  return typeof value === 'string' && THEME_PACKS.some((pack) => pack.id === value)
}

/** Which home layout to show: the theme package's own, or a fixed one. */
export type LayoutChoice = 'match' | ThemePackId
export const LAYOUT_STORAGE_KEY = 'ui-layout'

/** Packages that ship their own home screen; the rest use Legacy's. */
export const PACKS_WITH_HOME_LAYOUT: ThemePackId[] = ['legacy', 'calm']

export function isLayoutChoice(value: unknown): value is LayoutChoice {
  return value === 'match' || isThemePackId(value)
}

/** The home layout actually shown for a package and a layout choice. */
export function resolveHomeLayout(pack: ThemePackId, choice: LayoutChoice): ThemePackId {
  const wanted = choice === 'match' ? pack : choice
  return PACKS_WITH_HOME_LAYOUT.includes(wanted) ? wanted : 'legacy'
}
