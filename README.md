# Asset Verification & Tagging

An offline-first web app for physical asset verification and tagging exercises at
schools and institutions. Inspection teams walk room by room on a phone or tablet,
count and tag every item, take evidence photos, and sign each room off — with no
network connection required. Data syncs to a server whenever signal returns, and
the exercise exports to Excel and printable QR labels.

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
| Fixed assets register | One row per tagged item: tag, description, location, serial, brand/model, condition, inspector |
| Room-by-room summary | Everything found per room, plus a Room Totals sheet with sign-off state |
| Condition report | Fair / Poor / Unserviceable only, Unserviceable first |
| Variance report | Expected but not found, unlisted items found, rooms never inspected |
| Tag number register | Every issued tag in sequence, with a Printed column for the label run |

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
  lib/         tags · entries · queries · export-excel · labels · photos · sync
  pages/       Login · Inspect · Floor · Room · Entry · Dashboard · Reports · Labels · Setup · Sync
  components/  AppShell · ui primitives · charts
  i18n/        English + Swahili string tables
server/        Dependency-free Node sync API (node:sqlite) that also serves dist/
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
npm test          # 50 tests
npm run typecheck
```

| Suite | Covers |
|---|---|
| `src/lib/tags.test.ts` | Tag format, sequence allocation, tag stability when editing |
| `src/lib/entries.test.ts` | Validation, not-present, sign-off, soft delete, rollups, conflict resolution |
| `src/lib/export-excel.test.ts` | Row shape of all five reports against a populated exercise |
| `src/lib/sync.test.ts` | Client↔server round trip against a live server: push, pull, conflicts, photo upload |
| `server/sync.test.mjs` | The protocol itself: auth, conflict rules, soft deletes, photo endpoints |
| `src/test/app.test.tsx` | Sign-in, floor→room→checklist navigation, tag preview, dashboard, language toggle |

Tests run against a real in-memory IndexedDB (`fake-indexeddb`) and a real spawned
server process — no mocked database, no mocked HTTP.

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

## Environment variables (server)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `DATA_DIR` | `server/data` | SQLite database location |
| `UPLOAD_DIR` | `server/uploads` | Photo storage |
| `ADMIN_EMAIL` | `admin@sufa.ac.tz` | Seeded server admin |
| `ADMIN_PASSWORD` | `verify123` | Seeded server admin password — change this |

## Not built yet

Phase 3 from the brief: QR **scanning** to pull up an existing tag's history,
multi-exercise history and year-on-year analytics. The data model already carries
`exerciseId` throughout, and tags parse back to asset/floor/room/sequence via
`parseTag()`, so both build on what is here. Photos sync upward only — a second
device pulls photo records but not the image bytes.
