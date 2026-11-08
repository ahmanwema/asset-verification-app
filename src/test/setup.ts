/**
 * Test environment: jsdom plus a real in-memory IndexedDB, so the Dexie layer
 * under test is the same code the phone runs — no mocked database.
 */
import 'fake-indexeddb/auto'
import { afterEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

// The server tests run in the node environment, where none of the DOM shims below apply.
const isBrowserEnv = typeof window !== 'undefined'

// jsdom has no canvas; photo compression falls back to the original blob.
if (isBrowserEnv && !HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
}

if (!('createImageBitmap' in globalThis)) {
  Object.defineProperty(globalThis, 'createImageBitmap', {
    value: async () => ({ width: 100, height: 100, close() {} }),
    configurable: true,
  })
}

if (isBrowserEnv && !URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}
}

if (isBrowserEnv && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

afterEach(() => {
  vi.useRealTimers()
})
