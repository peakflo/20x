import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

// Suppress xterm.js internal "toFixed is not a function" crash.
// xterm's _reportWindowsOptions() calls .toFixed() on dimension values that
// are undefined when the renderer hasn't computed layout yet (e.g. during
// window moves, canvas viewport transitions, or shell startup queries).
// The error is cosmetic — xterm recovers on the next valid render cycle.
window.addEventListener('error', (e) => {
  if (e.message && e.message.includes('toFixed is not a function')) {
    e.preventDefault()
  }
})

// Tag <html> with platform so CSS can adapt (e.g. Windows title-bar padding)
if (navigator.userAgent.includes('Windows')) {
  document.documentElement.setAttribute('data-platform', 'win32')
} else if (navigator.userAgent.includes('Mac')) {
  document.documentElement.setAttribute('data-platform', 'darwin')
} else {
  document.documentElement.setAttribute('data-platform', 'linux')
}

// Apply theme early to prevent flash of wrong theme
// The ui-store module also does this, but this runs before React hydration
const savedTheme = localStorage.getItem('20x-theme') || 'dark'
if (savedTheme === 'system') {
  document.documentElement.setAttribute('data-theme',
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
} else {
  document.documentElement.setAttribute('data-theme', savedTheme)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
