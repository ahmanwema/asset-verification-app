import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { I18nProvider } from './i18n'
import { SessionProvider } from './state/session'
import { seedIfEmpty } from './db/seed'
import { registerSW } from 'virtual:pwa-register'
import './index.css'

/**
 * Keep the installed app on the current build.
 *
 * A service worker only looks for a new version when the page is navigated,
 * and an installed PWA on a phone may not be navigated for days — so a fixed
 * bug can stay broken on the device that reported it. This checks every
 * minute and, because registerType is 'autoUpdate', reloads when one lands.
 */
function keepUpToDate() {
  if (!('serviceWorker' in navigator)) return
  try {
    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return
        setInterval(() => void registration.update().catch(() => {}), 60_000)
      },
    })
  } catch (err) {
    console.error('Service worker registration failed', err)
  }
}

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

keepUpToDate()
void bootstrap()
