import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Asset Verification & Tagging',
        short_name: 'AssetVerify',
        description: 'Offline-first physical asset verification and tagging for schools and institutions',
        theme_color: '#0f766e',
        background_color: '#f8fafc',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        // Without this, a navigation to /api/* would be answered from the
        // precached index.html and the caller would parse HTML as JSON. It
        // matters on Vercel, where the API and the app share one origin.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // The API must never be served from cache, in either direction:
            // a stale sync response would silently resurrect deleted records,
            // and a cached vision answer would describe the previous photo.
            // Offline, these requests fail and the app falls back to IndexedDB,
            // which is exactly what the offline-first flow expects.
            urlPattern: /\/api\/.*/,
            handler: 'NetworkOnly',
            method: 'POST',
          },
          {
            urlPattern: /\/api\/.*/,
            handler: 'NetworkOnly',
            method: 'GET',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    // Vercel serves this directory as the static site (outputDirectory in
    // vercel.json); the on-site Node server reads the same folder.
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // `npm run dev` proxies to the on-site Node server. To develop against
      // the serverless functions instead, run `vercel dev` (port 3000), which
      // serves both the app and api/ together.
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
})
