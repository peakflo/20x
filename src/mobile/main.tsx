import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/globals.css'

// Resolve light/dark before render. Mobile follows the OS by default (its CSP
// blocks an inline pre-paint script), honouring a stored preference if present.
;(function applyTheme() {
  try {
    const stored = localStorage.getItem('ui-theme') // 'light' | 'dark' | 'system'
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const dark = stored === 'dark' || ((stored === 'system' || !stored) && prefersDark)
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  } catch {
    /* keep the default dark class from index.html */
  }
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
