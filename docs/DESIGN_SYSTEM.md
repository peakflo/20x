# 20x Design System — "Aperture"

A ground-up visual language for 20x, replacing the previous dark-only
"Cursor Midnight" theme. Aperture pairs two ideas:

- A **structured spatial system** — calm neutral surfaces, hairline (1px)
  borders, generous whitespace, frosted translucent chrome, clear layout rhythm.
- **Warm, refined controls** — soft radii, gentle layered shadows, a
  distinctive brand accent, smooth micro-interactions, pill-shaped controls.

It ships **full light + dark** support (previously the app was dark-only).

---

## Theming architecture

Colors are runtime CSS variables mapped into Tailwind v4 via `@theme inline`,
so overriding the variable under `.dark` re-skins the whole app instantly.

```
@theme inline { --color-background: var(--background); … }
:root  { --background: #f7f7f5; … }   /* light (default) */
.dark  { --background: #131316; … }   /* dark */
```

- `.dark` is toggled on `<html>` by `stores/theme-store.ts`.
- A pre-paint script in `index.html` sets the class before React mounts to
  avoid a flash of the wrong theme.
- Preference (`light` | `dark` | `system`) persists in `localStorage['ui-theme']`.
  Default is `dark` (preserves the prior look); `system` follows the OS.
- Mobile mirrors the palette (`src/mobile/styles/globals.css`) and resolves the
  theme in `main.tsx` (its CSP forbids inline scripts + CDN fonts).

Because ~92% of components already used semantic tokens (`bg-background`,
`text-muted-foreground`, `border-border`, …), rewriting the token layer
re-skinned the app automatically.

## Typography

- **UI / body:** Inter (weights 400/500/600/700), with a strong system fallback
  stack. Tight tracking (`-0.006em`), OpenType features `cv01 cv03 ss01`.
- **Mono:** JetBrains Mono → `ui-monospace` fallback (code / tabular).
- Base size 14px; section labels use uppercase micro-caps (`text-[13px]`,
  `tracking-wider`, muted).

## Color tokens

| Token | Light | Dark |
|---|---|---|
| `background` | `#f7f7f5` (warm paper) | `#131316` (deep charcoal) |
| `foreground` | `#1a1a1c` | `#ececee` |
| `card` / `popover` | `#ffffff` | `#1b1b1f` / `#1c1c20` |
| `primary` | `#2e5ce6` | `#6a8ef2` |
| `muted-foreground` | `#6c6c72` | `#8b8b93` |
| `border` | `#e7e7e3` (hairline) | `#2a2a2e` |
| `sidebar` | `#f2f2ef` | `#161619` |
| `destructive` | `#e5484d` | `#f0575d` |
| `success` | `#2f9e63` | `#3ecf8e` |
| `warning` | `#d9820b` | `#f0a63c` |

The dark theme moved from the old **blue-tinted** grays to a **neutral
charcoal**. Widely-used Tailwind accent shades
(`text-*-400`) are darkened in light mode via variable overrides so status
colors stay legible on paper without editing 90+ files.

## Shape, elevation & motion

- **Radii:** `xs 6 · sm 8 · md 10 · lg 14 · xl 18 · 2xl 24` (softer than before).
- **Shadows:** mode-aware `--shadow-xs → lg` + `--shadow-pop`; surfaced as
  `.shadow-xs / .shadow-card / .shadow-pop / .shadow-float` utilities.
- **Frost:** `.frost` = translucent chrome + `backdrop-filter: blur(20px)` — the
  "half-transparency" effect used by the top bar and dialog overlays.
- **Motion:** 150ms control transitions, `active:scale-[0.98]` press feedback,
  cross-fading theme toggle.

## Layout / chrome

- **Top bar** (52px): frosted, hairline bottom border. Left = logo chip +
  wordmark; center = **segmented pill nav** (active tab is a raised card);
  right = **theme toggle**, settings icon, divider, Mastermind button.
- **Sidebar** (264px): distinct `sidebar` surface, micro-cap section headers,
  `rounded-lg` card inputs with a 2px focus ring, refined footer stats.
- **Controls:** Buttons/Inputs/Selects use `rounded-lg`, `bg-card` surfaces,
  `ring-2 ring-ring/20` focus. Dialogs are `rounded-2xl` with `shadow-float`
  over a token-driven `--overlay` scrim.

## Files

- `src/renderer/src/styles/globals.css` — desktop design system
- `src/mobile/styles/globals.css` — mobile design system
- `src/renderer/src/stores/theme-store.ts` — theme state + persistence
- `src/renderer/src/components/layout/ThemeToggle.tsx` — light/dark switch
- `src/renderer/src/components/layout/{AppLayout,Sidebar}.tsx` — app shell
- `src/renderer/src/components/ui/*` — Button, Input, Select, Badge, Dialog, …

## Deliberate scope notes

- The **infinite-canvas** panels (terminal, browser, web) keep their dark
  technical chrome in both themes — a light canvas wrapping dark terminal
  panels reads worse than a consistently dark workspace surface.
