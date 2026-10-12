export const DEFAULT_GLASS_OPACITY = 55
export const GLASS_OPACITY_STORAGE_KEY = 'ui-glass-opacity'

export function clampGlassOpacity(value: number): number {
  return Number.isFinite(value) ? Math.max(40, Math.min(100, Math.round(value))) : DEFAULT_GLASS_OPACITY
}

export function applyGlassOpacity(value: number, root: HTMLElement = document.documentElement): number {
  const next = clampGlassOpacity(value)
  const solidProgress = Math.max(0, (next - DEFAULT_GLASS_OPACITY) / (100 - DEFAULT_GLASS_OPACITY))
  root.style.setProperty('--glass-opacity', `${next}%`)
  root.style.setProperty('--glass-solid-mix', `${(solidProgress ** 3) * 100}%`)
  root.style.setProperty('--glass-blur-factor', String(1 - solidProgress))
  root.style.setProperty('--glass-popover-alpha', String(Math.min(1, 0.84 + (next - DEFAULT_GLASS_OPACITY) * 0.0015)))
  root.classList.toggle('glass-solid-mode', next === 100)
  return next
}

export function readGlassOpacity(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(GLASS_OPACITY_STORAGE_KEY)
    return raw == null ? DEFAULT_GLASS_OPACITY : clampGlassOpacity(Number(raw))
  } catch {
    return DEFAULT_GLASS_OPACITY
  }
}
