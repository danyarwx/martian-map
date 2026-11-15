import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The tablet screen (/nav) installs as an app and works without a network. The service worker is registered
// by src/nav-ui/NavApp.tsx only. Its scope is / because the planner worker (/assets/...) must be controlled
// too, or it cannot load offline. The planning web app at / is never answered from the cache: only /nav
// gets the offline page (navigateFallbackAllowlist), and '/' is not mapped to index.html (directoryIndex).
// Its hashed assets may come from the precache, which is the same files the server has.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      injectRegister: false,
      includeManifestIcons: false, // the icons are already in the precache list below
      registerType: 'autoUpdate',
      filename: 'sw.js',
      manifest: {
        name: 'Martian Map Nav',
        short_name: 'Mars Nav',
        description: 'Turn-by-turn excursion navigation for Jezero crater.',
        start_url: '/nav',
        scope: '/nav',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#0e1116',
        theme_color: '#0e1116',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app, and the site data the navigation screen loads: terrain grids, stop photos, mineral image.
        globPatterns: ['**/*.{js,css,html,png,jpg,json,bin}'],
        // Rover track files, rover photo frames and the slope picture are only used by the planning web app.
        // The helmet's terrain tiles and weather (16 MB) are loaded by the helmet view from the network.
        globIgnores: ['data/M20_*', 'data/jezero_slope.png', 'data/frames/**', 'data/helmet/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // the elevation grid is 2.1 MB
        navigateFallback: 'index.html',
        directoryIndex: null,
        navigateFallbackAllowlist: [/^\/nav/],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // Mars Trek tiles. Trek sends Access-Control-Allow-Origin: *, and the map requests tiles with CORS,
            // so these are normal responses. Status 0 is accepted in case an opaque one slips through.
            // The cache name must match TILE_CACHE in src/nav-ui/offline.ts.
            urlPattern: /^https:\/\/trek\.nasa\.gov\/tiles\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'trek-tiles',
              expiration: { maxEntries: 30000 },
              cacheableResponse: { statuses: [0, 200] },
              matchOptions: { ignoreVary: true },
            },
          },
        ],
      },
    }),
  ],
})
