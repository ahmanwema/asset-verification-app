import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import App from '../App'
import { I18nProvider } from '../i18n'
import { SessionProvider } from '../state/session'
import { SEED_PASSWORD, seedIfEmpty, startFresh } from '../db/seed'
import { db, setMeta } from '../db/db'
import { sha256 } from '../lib/hash'
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

describe('more details', () => {
  async function openChairForm() {
    await signIn()
    fireEvent.click(await screen.findByText('1st Floor'))
    fireEvent.click(await screen.findByText('P3'))
    fireEvent.click(await screen.findByText('Student Chair'))
  }

  it('keeps the detail fields behind a collapsed section so the quick path stays short', async () => {
    await openChairForm()
    expect(await screen.findByText('More details')).toBeTruthy()
    // Collapsed by default: the inputs are not mounted.
    expect(screen.queryByLabelText('Material')).toBeNull()

    fireEvent.click(screen.getByText('More details'))
    expect(await screen.findByLabelText('Material')).toBeTruthy()
    expect(screen.getByLabelText('Colour')).toBeTruthy()
    expect(screen.getByLabelText('Item type')).toBeTruthy()
    expect(screen.getByLabelText('Additional features')).toBeTruthy()
    expect(screen.getByLabelText('Position in room')).toBeTruthy()
    expect(screen.getByLabelText('Description')).toBeTruthy()
  })

  it('saves the detail fields onto the entry', async () => {
    await openChairForm()
    fireEvent.click(await screen.findByText('More details'))

    fireEvent.change(await screen.findByLabelText('Material'), {
      target: { value: 'Wooden seat and backrest with metal frame' },
    })
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: 'Light Brown / Grey' } })
    fireEvent.change(screen.getByLabelText('Position in room'), { target: { value: 'Front left corner' } })
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Single-seater student chair with grey metal legs' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(async () => {
      const [entry] = await db.entries.toArray()
      expect(entry.material).toBe('Wooden seat and backrest with metal frame')
      expect(entry.colour).toBe('Light Brown / Grey')
      expect(entry.specificPosition).toBe('Front left corner')
      expect(entry.description).toBe('Single-seater student chair with grey metal legs')
    })
  })

  it('reopens the section for an entry that already has details', async () => {
    await openChairForm()
    fireEvent.click(await screen.findByText('More details'))
    fireEvent.change(await screen.findByLabelText('Colour'), { target: { value: 'Grey' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // Wait for the room checklist to show the saved entry before reopening it,
    // so the assertion is not racing the save round-trip.
    await screen.findByText('1/16 items checked', undefined, { timeout: 5000 })
    fireEvent.click(screen.getByText('Student Chair'))
    expect(await screen.findByDisplayValue('Grey', undefined, { timeout: 5000 })).toBeTruthy()
  })
})

describe('capture & identify', () => {
  const photo = () => new File([new Uint8Array([1, 2, 3])], 'item.jpg', { type: 'image/jpeg' })

  async function openChairForm() {
    await signIn()
    fireEvent.click(await screen.findByText('1st Floor'))
    fireEvent.click(await screen.findByText('P3'))
    fireEvent.click(await screen.findByText('Student Chair'))
    return (await screen.findByText('Capture & identify')).closest('button') as HTMLElement
  }

  function fileInputFor(button: HTMLElement): HTMLInputElement {
    // The hidden camera input sits directly after its button.
    return button.nextElementSibling as HTMLInputElement
  }

  function stubVision(result: Record<string, unknown>, model = 'gpt-4o') {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ model, result }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says so plainly when the device is not connected to the sync server', async () => {
    const button = await openChairForm()
    fireEvent.change(fileInputFor(button), { target: { files: [photo()] } })

    expect(await screen.findByText(/connect to the sync server/i)).toBeTruthy()
  })

  it('fills the form from the model response and can undo it', async () => {
    await setMeta('syncToken', 'test-token')
    stubVision({
      assetTypeCode: 'SC',
      itemName: 'Student Chair',
      itemType: 'Single-seater student chair',
      quantity: 4,
      condition: 'F',
      material: 'Wooden seat and backrest with metal frame',
      colour: 'Light Brown / Grey',
      brand: 'Furnico',
      model: 'Classic',
      serialNumber: 'SN-991',
      additionalFeatures: 'Pen groove under the seat',
      description: 'Single-seater student chair with grey metal legs',
      specificPosition: 'Front left corner',
      remarks: 'Scratches on the backrest',
      confidence: 0.82,
    })

    const button = await openChairForm()
    fireEvent.change(fileInputFor(button), { target: { files: [photo()] } })

    // Quantity, serial and the detail fields all arrive pre-filled.
    expect(await screen.findByDisplayValue('4')).toBeTruthy()
    expect(await screen.findByDisplayValue('SN-991')).toBeTruthy()
    expect(await screen.findByDisplayValue('Wooden seat and backrest with metal frame')).toBeTruthy()
    expect(screen.getByDisplayValue('Front left corner')).toBeTruthy()
    expect(screen.getByDisplayValue('Furnico')).toBeTruthy()

    // The inspector is told to check the values rather than trust them.
    expect(screen.getByText(/review every field/i)).toBeTruthy()

    fireEvent.click(screen.getByText('Undo AI fill'))
    await waitFor(() => expect(screen.queryByDisplayValue('SN-991')).toBeNull())
    expect(screen.queryByDisplayValue('Wooden seat and backrest with metal frame')).toBeNull()
    expect(screen.getByDisplayValue('1')).toBeTruthy() // quantity restored
  })

  it('marks the saved entry as AI assisted and keeps the photo', async () => {
    await setMeta('syncToken', 'test-token')
    stubVision(
      {
        assetTypeCode: 'SC',
        itemName: 'Student Chair',
        itemType: '',
        quantity: 2,
        condition: 'G',
        material: 'Plastic',
        colour: 'Blue',
        brand: '',
        model: '',
        serialNumber: '',
        additionalFeatures: '',
        description: 'Blue plastic student chair',
        specificPosition: '',
        remarks: '',
        confidence: 0.5,
      },
      'gpt-4o-mini',
    )

    const button = await openChairForm()
    fireEvent.change(fileInputFor(button), { target: { files: [photo()] } })
    await screen.findByDisplayValue('Blue plastic student chair')
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(async () => {
      const [entry] = await db.entries.toArray()
      expect(entry.aiAssisted).toBe(true)
      expect(entry.quantity).toBe(2)
      expect(entry.material).toBe('Plastic')
      expect(entry.photoIds).toHaveLength(1)
    })
  })
})

describe('edit history', () => {
  it('logs a change, flags the field and lists it in the history section', async () => {
    await signIn()
    fireEvent.click(await screen.findByText('1st Floor'))
    fireEvent.click(await screen.findByText('P3'))
    fireEvent.click(await screen.findByText('Student Chair'))

    // First save: recording an item is not an edit, so there is no history yet.
    await screen.findByDisplayValue('1')
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await screen.findByText('1/16 items checked', undefined, { timeout: 5000 })

    fireEvent.click(screen.getByText('Student Chair'))
    const qty = await screen.findByDisplayValue('1', undefined, { timeout: 5000 })
    expect(screen.queryByText('Edit history')).toBeNull()

    fireEvent.change(qty, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await screen.findByText('1/16 items checked', undefined, { timeout: 5000 })

    fireEvent.click(screen.getByText('Student Chair'))
    const heading = await screen.findByText('Edit history', undefined, { timeout: 5000 })
    const card = heading.closest('div.card') as HTMLElement

    // The quantity change is marked on the field itself, not only in the log.
    expect(screen.getAllByText('edited').length).toBeGreaterThan(0)

    fireEvent.click(heading)
    expect(await within(card).findByText('Quantity')).toBeTruthy()
    expect(within(card).getByText('1')).toBeTruthy() // old value
    expect(within(card).getByText('3')).toBeTruthy() // new value
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

describe('starting fresh', () => {
  it('empties the device and keeps the sample exercise from coming back', async () => {
    expect(await db.rooms.count()).toBe(51)

    await startFresh()
    expect(await db.rooms.count()).toBe(0)
    expect(await db.organizations.count()).toBe(0)
    expect(await db.inspectors.count()).toBe(0)

    // The next app load must not re-seed, or "start fresh" would be a no-op.
    await seedIfEmpty()
    expect(await db.organizations.count()).toBe(0)
    expect(await db.rooms.count()).toBe(0)
  })
})

describe('signing in on a device with no accounts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls back to the server, then works offline afterwards', async () => {
    // A phone that has never synced — or one that was just wiped.
    await startFresh()
    expect(await db.inspectors.count()).toBe(0)

    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            token: 'server-token',
            inspector: { id: 'usr_1', name: 'Aman Wema', email: 'admin@sufa.ac.tz', role: 'admin' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderApp()
    fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: 'admin@sufa.ac.tz' } })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'real-server-password' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    // The account now exists on the device, written from the server's answer.
    await waitFor(
      async () => {
        const [who] = await db.inspectors.toArray()
        expect(who?.email).toBe('admin@sufa.ac.tz')
        expect(who?.role).toBe('admin')
        expect(who?.passwordHash).toBeTruthy() // so the next sign-in needs no signal
      },
      { timeout: 5000 },
    )
    // ...and the sign-in form is gone. There is no exercise yet on a fresh
    // device, so the app lands on an empty state rather than a floor list.
    await waitFor(() => expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull())

    // Exactly one round trip: the session's own sign-in. The page must not
    // then ask again for a token it already holds.
    const loginCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/login'))
    expect(loginCalls).toHaveLength(1)
  })

  it('signs in from the device alone when the network is unreachable', async () => {
    // Every request fails, as it would in a classroom with no signal.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await signIn() // seeded account, correct password
    expect(await screen.findByText('Ground Floor')).toBeTruthy()
  })

  it('still refuses a wrong password when the server refuses it too', async () => {
    await startFresh()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid-credentials"}', { status: 401 })))

    renderApp()
    fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: 'admin@sufa.ac.tz' } })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    expect(await screen.findByText(/wrong email or password/i)).toBeTruthy()
    expect(await db.inspectors.count()).toBe(0)
  })
})

describe('registering an institution', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates the organization, clears the sample data and signs the admin in', { timeout: 20000 }, async () => {
    const now = Date.now()
    const hash = await sha256('a-good-password')

    // Stands in for the serverless API: register, then the pull that brings
    // the new tenant's organization, exercise and admin down to the device.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const target = String(url)
        if (target.includes('/register')) {
          return new Response(
            JSON.stringify({
              token: 'server-token',
              inspector: { id: 'usr_1', name: 'Asha Mushi', email: 'asha@mlimani.ac.tz', role: 'admin' },
              organization: { id: 'org_1', name: 'Mlimani Secondary' },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (target.includes('/sync')) {
          return new Response(
            JSON.stringify({
              serverTime: now,
              accepted: {},
              conflicts: [],
              changes: {
                organizations: [
                  { id: 'org_1', name: 'Mlimani Secondary', address: 'Dodoma', updatedAt: now },
                ],
                exercises: [
                  {
                    id: 'ex_1',
                    orgId: 'org_1',
                    name: 'Asset Verification 2026',
                    date: '2026-11-09',
                    status: 'active',
                    approvedBy: '',
                    teamLeaderId: 'usr_1',
                    updatedAt: now,
                  },
                ],
                inspectors: [
                  {
                    id: 'usr_1',
                    name: 'Asha Mushi',
                    email: 'asha@mlimani.ac.tz',
                    role: 'admin',
                    active: true,
                    passwordHash: hash,
                    updatedAt: now,
                  },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )

    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: /register an institution/i }))

    fireEvent.change(await screen.findByLabelText('Institution name'), {
      target: { value: 'Mlimani Secondary' },
    })
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Asha Mushi' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'asha@mlimani.ac.tz' } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'a-good-password' } })
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'a-good-password' } })
    fireEvent.click(screen.getByRole('button', { name: /create institution/i }))

    // The Sufa Schools sample is gone, replaced by the registered tenant.
    await waitFor(
      async () => {
        const orgs = await db.organizations.toArray()
        expect(orgs.map((o) => o.name)).toEqual(['Mlimani Secondary'])
      },
      { timeout: 8000 },
    )

    // ...and the admin is signed in, with the new institution in the header.
    expect(await screen.findByText('Mlimani Secondary', undefined, { timeout: 8000 })).toBeTruthy()
    expect(await db.rooms.count()).toBe(0)
    expect(await db.assetTypes.count()).toBe(0)
  })

  it('refuses a password that does not match its confirmation, without calling the server', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: /register an institution/i }))
    fireEvent.change(await screen.findByLabelText('Institution name'), { target: { value: 'X School' } })
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Someone' } })
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.tz' } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'a-good-password' } })
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'different' } })
    fireEvent.click(screen.getByRole('button', { name: /create institution/i }))

    expect(await screen.findByText(/do not match/i)).toBeTruthy()
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/register'))).toEqual([])
  })
})

describe('a second device joining an exercise', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pulls the exercise on first load, with nothing of its own to push', async () => {
    // A phone that has just signed in: empty, connected, nothing pending.
    await startFresh()
    await setMeta('syncToken', 'server-token')

    const now = Date.now()
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          serverTime: now,
          accepted: {},
          conflicts: [],
          changes: {
            organizations: [{ id: 'org_1', name: 'Loyola High School', address: '', updatedAt: now }],
            exercises: [
              {
                id: 'ex_1',
                orgId: 'org_1',
                name: 'Asset Verification 2026',
                date: '2026-11-09',
                status: 'active',
                approvedBy: '',
                teamLeaderId: 'usr_1',
                updatedAt: now,
              },
            ],
            inspectors: [
              {
                id: 'usr_1',
                name: 'Aman',
                email: 'aman@loyola.ac.tz',
                role: 'admin',
                active: true,
                passwordHash: await sha256('a-good-password'),
                updatedAt: now,
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    await db.inspectors.put({
      id: 'usr_1',
      name: 'Aman',
      email: 'aman@loyola.ac.tz',
      role: 'admin',
      active: true,
      passwordHash: await sha256('a-good-password'),
      updatedAt: now,
      syncStatus: 'synced',
    })

    renderApp()
    fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: 'aman@loyola.ac.tz' } })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'a-good-password' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    // The shell pulls without being asked, and the exercise appears.
    await waitFor(
      async () => expect(await db.exercises.count()).toBe(1),
      { timeout: 8000 },
    )
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/sync'))).toBe(true)
  })
})

describe('moving between items in a room', () => {
  it('does not carry one item form over to the next', async () => {
    await signIn()
    fireEvent.click(await screen.findByText('1st Floor'))
    fireEvent.click(await screen.findByText('P3'))

    // Fill in the chair without saving: quantity, and a detail field of the
    // kind photo recognition writes.
    fireEvent.click(await screen.findByText('Student Chair'))
    fireEvent.change(await screen.findByDisplayValue('1'), { target: { value: '7' } })
    fireEvent.click(await screen.findByText('More details'))
    fireEvent.change(await screen.findByLabelText('Material'), {
      target: { value: 'Folding chair, metal frame' },
    })

    // Walk back and open a different asset type.
    fireEvent.click(screen.getByRole('link', { name: /back/i }))
    fireEvent.click(await screen.findByText('Student Table'))

    // The table form must be its own: no quantity, no description from the chair.
    expect(await screen.findByDisplayValue('1')).toBeTruthy()
    expect(screen.queryByDisplayValue('7')).toBeNull()
    expect(screen.queryByDisplayValue('Folding chair, metal frame')).toBeNull()
    expect(screen.queryByLabelText('Material')).toBeNull() // details collapsed again
  })

  it('starts the next item clean after Save & next', async () => {
    await signIn()
    fireEvent.click(await screen.findByText('1st Floor'))
    fireEvent.click(await screen.findByText('P3'))
    fireEvent.click(await screen.findByText('Student Chair'))

    fireEvent.change(await screen.findByDisplayValue('1'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: /save & next/i }))

    // Whatever type comes next, it starts at one rather than inheriting nine.
    expect(await screen.findByDisplayValue('1', undefined, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByDisplayValue('9')).toBeNull()
  })
})
