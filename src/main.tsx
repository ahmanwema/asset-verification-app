import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { I18nProvider } from './i18n'
import { SessionProvider } from './state/session'
import { seedIfEmpty } from './db/seed'
import './index.css'

async function bootstrap() {
  // Load the sample exercise on a fresh device so the app is usable immediately.
  try {
    await seedIfEmpty()
  } catch (err) {
    console.error('Seeding failed', err)
  }

  // Ask the browser to keep our IndexedDB data instead of evicting it under
  // storage pressure — a half-uploaded exercise must survive a day in the field.
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist()
    }
  } catch {
    /* not supported; nothing to do */
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <SessionProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </SessionProvider>
      </I18nProvider>
    </StrictMode>,
  )
}

void bootstrap()
