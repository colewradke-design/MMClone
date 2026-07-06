/**
 * sw.js
 * Purpose: Service Worker for PWA capabilities — offline caching of the complete static app shell, install prompt support, and cache versioning for updates. Precaches every delivered file exactly once. Cache-first fetch strategy (fast loads, works offline). No runtime logic, no IndexedDB, no game state.
 * Expected scale: ~85 LOC. Lifecycle events + minimal fetch handler.
 * Imports: None (classic script; loaded via navigator.serviceWorker.register)
 * Exports: None (event listeners on self)
 *
 * Registration note: Must be registered from index.html (or main.js init) with:
 *   if ('serviceWorker' in navigator) { navigator.serviceWorker.register('./sw.js'); }
 * This was not added to index.html per RULES §1 (one file / chat).
 *
 * -- Defold equivalent: N/A (browser PWA install/offline layer only)
 */

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const CACHE_VERSION = 'v1';
const CACHE_NAME = `mini-motorways-pwa-${CACHE_VERSION}`;

// Complete list of assets to precache (final asset list per RULES §7).
// All paths are relative to SW scope (directory containing sw.js).
// Icons omitted because the referenced files do not exist on disk (see Assumptions).
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './src/config.js',
  './src/state.js',
  './src/grid.js',
  './src/roads.js',
  './src/buildings.js',
  './src/pathfinding.js',
  './src/vehicles.js',
  './src/render.js',
  './src/input.js',
  './src/main.js',
  './workers/pathfindingWorker.js'
];

// -----------------------------------------------------------------------------
// Install event — precache app shell
// -----------------------------------------------------------------------------

/**
 * Precaches the entire application shell during installation.
 * Uses addAll for atomic install (fails fast if any asset 404s).
 * Calls skipWaiting so the new SW activates immediately instead of waiting for all tabs to close.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[sw.js] Precaching app shell v1');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.error('[sw.js] Precaching failed:', err);
      })
  );
});

// -----------------------------------------------------------------------------
// Activate event — clean old caches + claim clients
// -----------------------------------------------------------------------------

/**
 * On activation, removes any previous cache versions and immediately takes control
 * of all open clients (so the new SW starts intercepting without reload).
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.log('[sw.js] Deleting old cache:', key);
              return caches.delete(key);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// -----------------------------------------------------------------------------
// Fetch event — cache-first strategy with network fallback
// -----------------------------------------------------------------------------

/**
 * Intercepts all GET requests in scope.
 * Serves from Cache API if present (instant, offline-capable).
 * Falls back to network for anything not precached (future assets, dev).
 * Returns a simple 503 plaintext response if both cache and network fail.
 */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return; // ignore non-GET (POST etc.)
  }

  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).catch(() => {
          return new Response('Offline — resource not cached', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          });
        });
      })
  );
});
