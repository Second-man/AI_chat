import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import OverlayAssistant from './OverlayAssistant.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode><OverlayAssistant /></StrictMode>,
)
