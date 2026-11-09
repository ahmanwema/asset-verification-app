# Asset Verification & Tagging

An offline-first web app for physical asset verification and tagging exercises at
schools and institutions. Inspection teams walk room by room on a phone or tablet,
count and tag every item, take evidence photos, and sign each room off — with no
network connection required. Data syncs to a server whenever signal returns, and
the exercise exports to Excel and printable QR labels.

Items can be described in as much or as little detail as the exercise needs, and
a photo can be handed to a vision model that pre-fills the whole form for the
inspector to check.

Built for the Sufa Schools layout (5 floors, 51 rooms, 16 asset types), which loads
as sample data on first run.

---

## Quick start

```bash
npm install
npm run dev            # app on http://localhost:5173
npm run server         # sync API on http://localhost:4000 (separate terminal)
```

Sign in with any seeded account — password **`verify123`**:

| Email | Role |
|---|---|
| `admin@sufa.ac.tz` | Admin (full setup access) |
| `leader@sufa.ac.tz` | Inspector (team leader) |
| `inspector2@sufa.ac.tz` | Inspector |

Change these in **Setup → Team** before any real exercise.

### Running on site

```bash
npm start              # build, then serve app + API from one process on :4000
```

The server also serves the built PWA, so a laptop on the site Wi-Fi covers the
whole exercise. Point the phones at `http://<laptop-ip>:4000`, then set the same
address in **Sync → Sync server** (e.g. `http://192.168.1.50:4000/api`).

### Installing on a phone

Open the app in Chrome or Safari and choose *Add to Home Screen*. It installs as a
PWA, and after the first load every screen, the asset catalog and the export code
work with no signal.

---

## How an exercise runs

```
Admin:     Setup → organization, floors/rooms, asset catalog, team
   ↓
Inspector: Sign in → Floor → Room → checklist of all 16 asset types
   ↓       For each: quantity, serial, brand/model, condition, photo, remarks
   ↓       One tap for "not present"; "+ Add unlisted item" for surprises
   ↓       Sign the room off when done
   ↓
Leader:    Dashboard → live progress, condition breakdown, room map
   ↓
Output:    Reports → 5 Excel reports · Labels → printable QR tags
```

### Tag numbers

Every tagged item gets `[AssetCode]-[FloorCode]-[RoomCode]-[Seq]`:

```
SC-1F-P3-001   Student Chair, 1st Floor, room P3, item 1
```

Sequences are allocated per asset type per room and continue from the highest
number already issued there. Editing an entry keeps the tags it already holds, so
a label stuck on a chair yesterday stays valid when the quantity changes today.
Manual tag entry is available per entry for pre-printed labels.

### Quantities above one

A row of 30 chairs can be recorded two ways:

- **One condition for all** — the common case, one tap.
- **Split by condition** — e.g. `28 Good, 2 Poor`, validated to add up to the
  quantity. The register then emits 28 Good rows and 2 Poor rows, each with its
  own tag number, and the condition report picks up only the 2.

### Detail fields

The quick path stays short: quantity, serial, brand/model, condition, photo,
remarks. Everything richer sits behind a collapsed **More details** section on
the entry form, which opens by itself when an entry already has some:

| Field | Example |
|---|---|
| Item type | `Top-Loading Water Dispenser` |
| Material | `Wooden seat and backrest with metal frame` |
| Colour | `Light Brown / Grey` |
| Additional features | `Pen groove on tabletop`, `three water taps` |
| Position in room | `Front left corner`, `Mounted on east wall` |
| Description | `Single-seater student chair with wooden seat, wooden backrest and grey metal legs` |

All six flow into the fixed assets register and the room summary; position and
description also appear in the condition report, so whoever repairs an item can
find it. Entries recorded before this was added keep working — a Dexie v2
migration backfills them with empty strings.

### Capture & identify (photo recognition)

Next to the camera button on the entry form is **Capture & identify**. It takes a
photo, attaches it as evidence, sends it to a vision model, and pre-fills every
field it can read — quantity, condition, brand, model, serial, and all six detail
fields. A standing banner tells the inspector to review each value, **Undo AI
fill** restores exactly what was there before, and nothing is saved until they
tap Save. Entries that were pre-filled this way are flagged `AI Assisted` in the
register, so a reviewer can tell which rows started from a machine reading.

Set it up by copying `.env.example` to `.env` and filling in:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o        # or gpt-4o-mini to cut cost
```

Then restart the server. Without a key, everything else works exactly as before
and the button explains that recognition is not set up. Each device can override
the model in **Setup → Data → AI photo recognition**, which also shows whether
the server has a key.

**The key stays on the server.** The phone posts the photo to
`/api/vision/identify` on the sync server, and that server calls OpenAI. An
`OPENAI_API_KEY` given to the browser would be readable by anyone who opens the
app, so the client never sees it. Two consequences worth knowing: recognition
needs the device to be online *and* signed in to the sync server (**Sync →
Connect**), and photos of the institution's property leave the building for
OpenAI when it is used — the rest of the app never sends anything anywhere but
your own server.

The system prompt is one exported constant, `VISION_SYSTEM_PROMPT` in
[`server/vision.js`](server/vision.js). Edit it there and every device picks up
the change on its next request, with no app rebuild and nothing to redeploy to
the phones. It pins the JSON contract, the Good/Fair/Poor/Unserviceable rubric,
and one firm instruction: never invent a serial number, brand or model that is
not legible — return `""` instead, because a wrong serial corrupts the register.

### Edit history

Every field change to an item that was **already saved** is logged on the entry
itself: what changed, from what to what, by whom, and when. A first save is not
an edit, so a freshly recorded item has an empty log.

Fields that have been changed since are marked `edited` in the form, and the full
log sits in a collapsed **Edit history** section at the bottom of the entry. It
reads newest first, with values shown in the inspector's language.

Logged: quantity, not-present, condition and its breakdown, serials, brand,
model, tag numbers, all six detail fields, remarks, item name, photo count.
Deliberately not logged: `updatedAt`, `syncStatus`, `inspectedAt` and the
AI-assisted flag — those move on their own during a sync or a re-save, and would
bury the handful of changes an auditor cares about.

The log travels with the entry as part of the same JSON row, so it reaches the
server with the record it belongs to and survives a device being wiped. Each
entry keeps its newest 200 records (`EDIT_HISTORY_LIMIT` in
[`src/lib/entries.ts`](src/lib/entries.ts)); beyond that the oldest are dropped,
so one much-edited item cannot slow every sync on a weak connection.

Entries recorded before this existed keep working: the Dexie v3 migration gives
them an empty log rather than inventing records for changes nobody wrote down.

---

## Offline behaviour

- Everything is written to **IndexedDB first** (via Dexie); the network is never on
  the critical path of data entry.
- The app asks for **persistent storage** so a day's work is not evicted under
  storage pressure.
- Photos are downscaled to 1280px JPEG (~150–250 KB) and stored as raw bytes
  rather than `Blob`s, which older iOS Safari mishandles in IndexedDB.
- The header badge shows pending record count and online state; sync runs
  automatically about 1.5s after the connection returns.
- A service worker precaches the whole app shell, so a cold start in a basement
  with no signal still works.

### Sync and conflicts

Each record carries `updatedAt` and a `syncStatus` of `pending` / `synced` /
`conflict`. A sync round pushes everything pending, pulls everything changed since
the last run, then uploads pending photos.

The server flags a **conflict** when an incoming entry would overwrite a copy that
was last written *by a different inspector* and changed *after that device's last
sync* — the case where two inspectors unknowingly did the same room. The server
keeps its copy and returns it; the device stores it alongside the local record and
**Sync → Conflicts** offers *Keep mine* / *Keep theirs* side by side. Everything
else is last-write-wins. A pull never overwrites a local record with unsynced edits.

---

## Reports

**Reports** exports one workbook per report, or all of them together. Every sheet
is auto-filtered with a frozen header row, and each workbook carries a Summary
sheet with the exercise metadata.

| Report | Contents |
|---|---|
| Fixed assets register | One row per tagged item: tag, description, location, serial, brand/model, condition, the six detail fields, inspector, AI-assisted flag |
| Room-by-room summary | Everything found per room with the detail fields, plus a Room Totals sheet with sign-off state |
| Condition report | Fair / Poor / Unserviceable only, Unserviceable first, with position and description |
| Variance report | Expected but not found, unlisted items found, rooms never inspected |
| Tag number register | Every issued tag in sequence, with a Printed column for the label run |
| Edit log | Every field changed after an item was first recorded: old value, new value, who, when |

## Labels

**Labels** prints 50×30mm labels, 4 per row on A4: QR code (encoding the tag
number), tag number, asset description, room, organization and verification date.
Scope is one room, one floor or the whole exercise, and a room's labels can also be
printed straight from that room's screen. The QR codes are inlined as data URLs, so
printing works offline.

---

## Architecture

```
src/
  db/          Dexie schema (db.ts) and the Sufa Schools sample data (seed.ts)
  lib/         tags · entries · queries · export-excel · labels · photos · sync · vision
  pages/       Login · Inspect · Floor · Room · Entry · Dashboard · Reports · Labels · Setup · Sync
  components/  AppShell · ui primitives · charts
  i18n/        English + Swahili string tables
server/        Dependency-free Node sync API (node:sqlite) that also serves dist/
  index.js     HTTP, auth, sync protocol, photo store, static hosting
  vision.js    Photo recognition: the system prompt and the OpenAI call
```

| Layer | Choice | Why |
|---|---|---|
| UI | React 18 + TypeScript + Tailwind, Vite | Fast builds, small runtime, PWA plugin |
| Offline store | Dexie / IndexedDB | Reactive queries (`useLiveQuery`) keep the dashboard live |
| Server | Node `http` + `node:sqlite`, zero deps | Runs from a laptop on site with only Node installed |
| Excel | SheetJS, lazy-loaded | 430 KB kept out of the initial bundle |
| Charts | Hand-built HTML/CSS bars | No chart library; every value directly labelled |

Initial load is ~120 KB gzipped; SheetJS and the QR generator load on demand and
are still precached for offline use.

### Writes

All mutations go through `src/lib/entries.ts`, which stamps `updatedAt` and sets
`syncStatus: 'pending'`. Deletes are soft (`deleted: true`) so removals propagate.
Nothing writes to Dexie directly from a component.

### Bilingual UI

English and Swahili, toggled from the header (`EN` / `SW`) and remembered per
device. Asset types carry their own Swahili names, editable in Setup. The string
tables are in `src/i18n/strings.ts`; TypeScript fails the build if a Swahili key is
missing.

---

## Testing

```bash
npm test          # 87 tests
npm run typecheck
```

| Suite | Covers |
|---|---|
| `src/lib/tags.test.ts` | Tag format, sequence allocation, tag stability when editing |
| `src/lib/entries.test.ts` | Validation, not-present, sign-off, soft delete, rollups, conflict resolution, detail fields, edit history |
| `src/lib/export-excel.test.ts` | Row shape of all six reports against a populated exercise, including the edit log |
| `src/lib/sync.test.ts` | Client↔server round trip against a live server: push, pull, conflicts, photo upload |
| `server/sync.test.mjs` | The protocol itself: auth, conflict rules, soft deletes, photo and vision endpoints |
| `server/vision.test.mjs` | Photo recognition against a stub OpenAI: request shape, prompt, model override, junk-value repair, timeouts, missing key |
| `src/test/app.test.tsx` | Sign-in, floor→room→checklist navigation, tag preview, dashboard, language toggle, More details, AI fill and undo, edit history |

Tests run against a real in-memory IndexedDB (`fake-indexeddb`) and a real spawned
server process — no mocked database, no mocked HTTP. The vision tests point the
server at a local stub instead of OpenAI, so the suite needs no API key and
spends nothing.

---

## Security notes

This is a field tool, and the auth is deliberately simple. Before production use:

- **Offline sign-in** compares an unsalted SHA-256 hash held on the device. It
  gates the UI on a shared team device; it is not a defence against someone with
  the phone and a disk tool.
- **The server** stores scrypt hashes for accounts it creates, and accepts the
  SHA-256 hash for accounts created offline in the field, so those inspectors can
  authenticate too. Replace with a real identity provider for a multi-tenant
  deployment.
- The sync API has **no transport encryption of its own** — run it behind TLS, or
  keep it on a trusted site LAN.
- Photos are stored on the server's local disk under `server/uploads/`. Swap
  `handleSync`'s photo endpoints for S3 if you need durable object storage.
- **Photo recognition sends photographs to OpenAI.** The key is server-side and
  never reaches the phone, but the images themselves leave your network when the
  feature is used. Leave `OPENAI_API_KEY` unset if that is not acceptable for the
  institution; nothing else in the app contacts a third party.

## Environment variables (server)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `DATA_DIR` | `server/data` | SQLite database location |
| `UPLOAD_DIR` | `server/uploads` | Photo storage |
| `ADMIN_EMAIL` | `admin@sufa.ac.tz` | Seeded server admin |
| `ADMIN_PASSWORD` | `verify123` | Seeded server admin password — change this |
| `OPENAI_API_KEY` | _(unset)_ | Enables photo recognition; without it the feature is off |
| `OPENAI_MODEL` | `gpt-4o` | `gpt-4o` or `gpt-4o-mini` |
| `OPENAI_BASE_URL` | OpenAI | Point at a proxy or compatible gateway |
| `OPENAI_TIMEOUT_MS` | `45000` | How long to wait before telling the inspector it timed out |

## Not built yet

Phase 3 from the brief: QR **scanning** to pull up an existing tag's history,
multi-exercise history and year-on-year analytics. The data model already carries
`exerciseId` throughout, and tags parse back to asset/floor/room/sequence via
`parseTag()`, so both build on what is here. Photos sync upward only — a second
device pulls photo records but not the image bytes.
