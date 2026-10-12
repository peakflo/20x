import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/globals.css'
import { initAnalytics } from '@/lib/analytics'

initAnalytics('mobile')

// Resolve light/dark before render. Mobile follows the OS by default (its CSP
// blocks an inline pre-paint script), honouring a stored preference if present.
;(function applyTheme() {
  try {
    const stored = localStorage.getItem('ui-theme') // 'light' | 'dark' | 'system'
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const dark = stored === 'dark' || ((stored === 'system' || !stored) && prefersDark)
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    const glassOpacity = Number(localStorage.getItem('ui-glass-opacity'))
    if (glassOpacity >= 40 && glassOpacity <= 100) {
      document.documentElement.style.setProperty('--glass-opacity', `${glassOpacity}%`)
      document.documentElement.style.setProperty('--glass-blur', glassOpacity === 100 ? '0px' : '18px')
      document.documentElement.classList.toggle('glass-solid-mode', glassOpacity === 100)
    }
  } catch {
    /* keep the default dark class from index.html */
  }
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
