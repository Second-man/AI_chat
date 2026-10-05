import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import OverlayAssistant from './OverlayAssistant.tsx'

// `index.html` is the one page Tauri always packages. The child window uses
// the same document and receives its mode before navigation through Tauri's
// initialization script. This stays intact when Tauri proxies the Vite dev
// server to `tauri://localhost` (which strips URL parameters from dynamic
// child windows on Windows WebView2).
const isAssistantWindow = (window as Window & { __ECHOMATE_ASSISTANT__?: boolean }).__ECHOMATE_ASSISTANT__ === true

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAssistantWindow ? <OverlayAssistant /> : <App />}
  </StrictMode>,
)
