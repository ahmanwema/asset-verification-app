import { db, uid } from '../db/db'
import type { Photo } from '../types'

const MAX_EDGE = 1280
const JPEG_QUALITY = 0.72

/**
 * Downscales a camera capture before storing it. Phone photos are 3–8 MB each and
 * a full exercise can hold hundreds, which would blow past the browser's storage
 * quota; 1280px JPEG keeps a serial number readable at roughly 150–250 KB.
 */
export async function compressImage(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await loadBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return { blob: file, width: bitmap.width, height: bitmap.height }
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height)
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close()

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY),
  )
  return { blob: blob ?? file, width, height }
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      /* Safari < 15 and some WebViews: fall back to an <img> */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not decode image'))
      img.src = url
    })
    return img
  } finally {
    // Revoke after decode; the bitmap data is already in memory.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

export async function savePhoto(file: Blob, entryId: string, exerciseId: string): Promise<Photo> {
  const { blob, width, height } = await compressImage(file)
  const photo: Photo = {
    id: uid('ph_'),
    entryId,
    exerciseId,
    data: await blobToArrayBuffer(blob),
    contentType: blob.type || 'image/jpeg',
    width,
    height,
    createdAt: Date.now(),
    syncStatus: 'pending',
  }
  await db.photos.add(photo)
  return photo
}

/** Rebuilds a displayable Blob from the stored bytes. */
export function photoBlob(photo: Pick<Photo, 'data' | 'contentType'>): Blob {
  return new Blob([photo.data], { type: photo.contentType || 'image/jpeg' })
}

export async function deletePhoto(photoId: string): Promise<void> {
  await db.photos.delete(photoId)
}

export async function photosFor(entryId: string): Promise<Photo[]> {
  return db.photos.where('entryId').equals(entryId).toArray()
}

/** Rough estimate of how much space the exercise uses on this device. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Blob.arrayBuffer() is missing on Safari 13 and several older Android
 * WebViews — exactly the hardware a field team is likely to be carrying — so
 * fall back to FileReader, then to Response.
 */
export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  if (typeof FileReader !== 'undefined') {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error ?? new Error('Could not read photo'))
      reader.readAsArrayBuffer(blob)
    })
  }
  return new Response(blob).arrayBuffer()
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(await blobToArrayBuffer(blob))
}

export function bytesToBase64(data: ArrayBuffer): string {
  const buf = new Uint8Array(data)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk))
  }
  return btoa(binary)
}
