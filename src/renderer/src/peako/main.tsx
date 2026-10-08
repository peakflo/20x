import React from 'react'
import ReactDOM from 'react-dom/client'
import { PeakoApp } from './PeakoApp'
import '../styles/globals.css'
import './peako.css'

// Follow the app's theme package and light or dark choice when the main window changes them.
window.addEventListener('storage', (event) => {
  if (event.key === 'ui-theme-pack') {
    const pack = event.newValue
    if (pack && pack !== 'legacy') document.documentElement.setAttribute('data-theme-pack', pack)
    else document.documentElement.removeAttribute('data-theme-pack')
    return
  }
  if (event.key !== 'ui-theme') return
  const mode = event.newValue || 'dark'
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PeakoApp />
  </React.StrictMode>
)
