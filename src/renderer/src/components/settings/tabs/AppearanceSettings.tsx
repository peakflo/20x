import { SettingsSection } from '../SettingsSection'
import { useThemeStore, type ThemeMode } from '@/stores/theme-store'

export function AppearanceSettings() {
  const mode = useThemeStore((state) => state.mode)
  const setMode = useThemeStore((state) => state.setMode)
  const glassOpacity = useThemeStore((state) => state.glassOpacity)
  const setGlassOpacity = useThemeStore((state) => state.setGlassOpacity)
  const desktopBackdrop = useThemeStore((state) => state.desktopBackdrop)
  const setDesktopBackdrop = useThemeStore((state) => state.setDesktopBackdrop)
  const isMac = navigator.platform.toLowerCase().includes('mac')

  return (
    <SettingsSection title="Appearance" description="Choose the app theme and the clarity of floating controls">
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Theme</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Theme">
            {(['light', 'dark', 'system'] as ThemeMode[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={mode === option}
                className={`rounded-full border px-4 py-2 text-sm capitalize focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${mode === option ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="glass-opacity" className="text-sm font-medium text-foreground">Glass opacity</label>
            <output htmlFor="glass-opacity" className="text-sm tabular-nums text-muted-foreground">{glassOpacity}%</output>
          </div>
          <input
            id="glass-opacity"
            type="range"
            min="40"
            max="100"
            step="1"
            value={glassOpacity}
            onChange={(event) => setGlassOpacity(Number(event.target.value))}
            className="w-full accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <p className="text-xs text-muted-foreground">Lower values reveal more content behind floating controls. At 100%, blur turns off.</p>
        </div>
        {isMac && (
          <label className="flex items-start gap-3 rounded-xl border border-border p-3">
            <input
              type="checkbox"
              checked={desktopBackdrop}
              onChange={(event) => setDesktopBackdrop(event.target.checked)}
              className="mt-0.5 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">Blur desktop behind app</span>
              <span className="block text-xs text-muted-foreground">Show the macOS backdrop through page backgrounds. Reading surfaces stay solid. Turns off at 100% glass opacity or when reduced transparency is enabled.</span>
            </span>
          </label>
        )}
      </div>
    </SettingsSection>
  )
}
