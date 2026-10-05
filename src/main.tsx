import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import OverlayAssistant from './OverlayAssistant.tsx'

// `index.html` is the one page Tauri always packages. A secondary window uses
// the same document and switches only its React tree by URL. This avoids an
// installed Windows build opening a blank WebView when a separately emitted
// HTML entry cannot be resolved by the asset protocol. Do not query the Tauri
// window API here: Vite's external dev URL may render before that API is
// injected, which would otherwise abort React and leave a white rectangle.
const isAssistantWindow = new URLSearchParams(window.location.search).get('assistant') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAssistantWindow ? <OverlayAssistant /> : <App />}
  </StrictMode>,
)
