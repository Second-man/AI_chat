import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import './index.css'
import App from './App.tsx'
import OverlayAssistant from './OverlayAssistant.tsx'

// `index.html` is the one page Tauri always packages. A secondary window uses
// the same document and switches only its React tree by label. This avoids an
// installed Windows build opening a blank WebView when a separately emitted
// HTML entry cannot be resolved by the asset protocol.
const isAssistantWindow = getCurrentWebviewWindow().label === 'assistant'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAssistantWindow ? <OverlayAssistant /> : <App />}
  </StrictMode>,
)
