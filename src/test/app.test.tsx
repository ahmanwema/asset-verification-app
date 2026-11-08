import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import App from '../App'
import { I18nProvider } from '../i18n'
import { SessionProvider } from '../state/session'
import { SEED_PASSWORD, seedIfEmpty } from '../db/seed'
import { db } from '../db/db'
import { resetDb } from './fixtures'

function renderApp() {
  return render(
    <I18nProvider>
      <SessionProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SessionProvider>
    </I18nProvider>,
  )
}

async function signIn() {
  renderApp()
  const email = await screen.findByLabelText(/email/i)
  const password = screen.getByLabelText(/password/i)
  fireEvent.change(email, { target: { value: 'admin@sufa.ac.tz' } })
  fireEvent.change(password, { target: { value: SEED_PASSWORD } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

beforeEach(async () => {
  await resetDb()
  window.localStorage.clear()
  window.history.pushState({}, '', '/')
  await seedIfEmpty()
})

describe('sample data', () => {
  it('loads the Sufa Schools layout exactly once', async () => {
    expect(await db.floors.count()).toBe(5)
    expect(await db.rooms.count()).toBe(51)
    expect(await db.assetTypes.count()).toBe(16)

    await seedIfEmpty() // idempotent: a second call must not duplicate anything
    expect(await db.rooms.count()).toBe(51)
  })
})

describe('sign in', () => {
  it('refuses a wrong password and accepts the seeded one', async () => {
    renderApp()
    const email = await screen.findByLabelText(/email/i)
    fireEvent.change(email, { target: { value: 'admin@sufa.ac.tz' } })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(/wrong email or password/i)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: SEED_PASSWORD } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('Ground Floor')).toBeTruthy()
  })
})

describe('inspection walkthrough', () => {
  it('goes floor to room to checklist and records a missing item', async () => {
    await signIn()

    fireEvent.click(await screen.findByText('1st Floor'))
    const p3 = await screen.findByText('P3')
    fireEvent.click(p3)

    // The room checklist is pre-loaded with the whole catalog.
    expect(await screen.findByText('Student Chair')).toBeTruthy()
    expect(screen.getByText('Smart Board')).toBeTruthy()
    expect(await screen.findByText('0/16 items checked')).toBeTruthy()

    // One tap marks an asset type absent and advances the progress counter.
    const chairRow = screen.getByText('Student Chair').closest('div.card') as HTMLElement
    fireEvent.click(within(chairRow).getByRole('button', { name: /qty 0/i }))

    expect(await screen.findByText('1/16 items checked')).toBeTruthy()
    await waitFor(async () => {
      const entries = await db.entries.toArray()
      expect(entries).toHaveLength(1)
      expect(entries[0].notPresent).toBe(true)
      expect(entries[0].quantity).toBe(0)
      expect(entries[0].syncStatus).toBe('pending')
    })
  })

  it('records a counted item with auto-generated tags through the form', async () => {
    await signIn()

    fireEvent.click(await screen.findByText('1st Floor'))
    fireEvent.click(await screen.findByText('P3'))
    fireEvent.click(await screen.findByText('Student Chair'))

    // The tag preview reflects the quantity before anything is saved.
    const qty = await screen.findByDisplayValue('1')
    fireEvent.change(qty, { target: { value: '3' } })
    expect(await screen.findByText('SC-1F-P3-003')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(async () => {
      const entries = await db.entries.toArray()
      expect(entries).toHaveLength(1)
      expect(entries[0].quantity).toBe(3)
      expect(entries[0].tagNumbers).toEqual(['SC-1F-P3-001', 'SC-1F-P3-002', 'SC-1F-P3-003'])
    })
  })
})

describe('dashboard', () => {
  it('rolls the exercise up across floors', async () => {
    await signIn()
    fireEvent.click(await screen.findByRole('link', { name: /dashboard/i }))

    expect(await screen.findByText(/live progress/i)).toBeTruthy()
    expect(await screen.findByText('Rooms done')).toBeTruthy()
    // 51 rooms seeded, none done yet.
    expect(await screen.findByText('/ 51')).toBeTruthy()
    expect(screen.getByText('Condition breakdown')).toBeTruthy()
  })
})

describe('bilingual UI', () => {
  it('switches the whole interface to Swahili and back', async () => {
    await signIn()
    await screen.findByText('Ground Floor')

    fireEvent.click(screen.getByRole('button', { name: /switch language/i }))
    expect(await screen.findByText('Chagua ghorofa')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /switch language/i }))
    expect(await screen.findByText('Pick a floor')).toBeTruthy()
  })
})
