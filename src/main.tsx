import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import './index.css'
import App from './App.tsx'
import OverlayAssistant from './OverlayAssistant.tsx'

// The assistant is a configured, initially hidden Tauri window. Reading its
// label is safe after Tauri has initialized; the fallback keeps the normal UI
// usable when this page is opened in a regular browser for development.
let currentWindowLabel = ''
try {
  currentWindowLabel = getCurrentWebviewWindow().label
} catch {
  // Browser preview, where no Tauri bridge exists.
}
const isAssistantWindow = currentWindowLabel === 'assistant'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAssistantWindow ? <OverlayAssistant /> : <App />}
  </StrictMode>,
)
