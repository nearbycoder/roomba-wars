import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import BenchmarkApp from './BenchmarkApp'
import './index.css'

const params = new URLSearchParams(window.location.search)
const isBenchmarkMode = params.get('benchmark') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isBenchmarkMode ? <BenchmarkApp /> : <App />}
  </StrictMode>,
)
