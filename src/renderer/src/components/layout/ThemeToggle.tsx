import { Moon, Sun } from 'lucide-react'
import { useThemeStore } from '@/stores/theme-store'
import { cn } from '@/lib/utils'

/**
 * Compact light/dark switcher for the top bar.
 * Cross-fades a sun/moon glyph and flips the explicit theme preference.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const resolved = useThemeStore((s) => s.resolved)
  const toggle = useThemeStore((s) => s.toggle)
  const isDark = resolved === 'dark'

  return (
    <button
      type="button"
      onClick={toggle}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle theme"
      className={cn(
        'no-drag relative grid h-8 w-8 place-items-center rounded-lg text-muted-foreground',
        'transition-colors hover:bg-accent hover:text-foreground cursor-pointer',
        className
      )}
    >
      <Sun
        className={cn(
          'absolute h-4 w-4 transition-all duration-300',
          isDark ? 'scale-0 -rotate-90 opacity-0' : 'scale-100 rotate-0 opacity-100'
        )}
      />
      <Moon
        className={cn(
          'absolute h-4 w-4 transition-all duration-300',
          isDark ? 'scale-100 rotate-0 opacity-100' : 'scale-0 rotate-90 opacity-0'
        )}
      />
    </button>
  )
}
