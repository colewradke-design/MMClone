/**
 * workers/pathfindingWorker.js
 * Purpose: Web Worker wrapper for pathfinding.js enabling off-main-thread A* execution. Listens for findPath requests, invalidates the roads edge cache (to ensure fresh roads snapshot), delegates to findPath, and posts results back. Thin adapter only — no game logic or reimplementation.
 * Expected scale: ~75 LOC. Message protocol, error boundaries, and import glue.
 * Imports: ../src/pathfinding.js (findPath), ../src/roads.js (invalidateEdgeMap)
 * Exports: None (self.onmessage setup executes on worker load)
 *
 * Usage from main thread (future integration):
 *   const worker = new Worker(new URL('./workers/pathfindingWorker.js', import.meta.url), { type: 'module' });
 *   worker.postMessage({ type: 'findPath', requestId: 'req_123', roads: state.roads, start: {x:3,y:5}, goal: {x:10,y:12}, personality: 0.7 });
 *   worker.onmessage = (e) => { if (e.data.requestId === 'req_123') { /* use e.data.path */ } }
 *
 * -- Defold equivalent: N/A (Defold runtime is single-threaded; pathfinding would stay synchronous or use coroutines)
 */

// -----------------------------------------------------------------------------
// Imports
// -----------------------------------------------------------------------------

import { findPath } from '../src/pathfinding.js';
import { invalidateEdgeMap } from '../src/roads.js';

/** @typedef {{x: number, y: number}} TileCoord */

// -----------------------------------------------------------------------------
// Message handler
// -----------------------------------------------------------------------------

/**
 * Main message handler. Expects structured requests; replies with matching requestId for correlation.
 * Always invalidates edge map before delegating so that the worker's roads.js cache is rebuilt from the
 * exact roads array snapshot provided in this request (handles dynamic road edits from main thread).
 * @param {MessageEvent} event
 */
self.onmessage = (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== 'findPath') {
    return; // silently ignore non-requests or malformed
  }

  const { requestId, roads, start, goal, personality = 0.5 } = data;

  if (typeof requestId === 'undefined' || !Array.isArray(roads) || !start || !goal) {
    self.postMessage({
      type: 'pathResult',
      requestId,
      path: null,
      error: 'Missing required fields: requestId, roads (array), start, goal'
    });
    return;
  }

  try {
    // Critical: ensure worker's roads module cache matches the passed snapshot
    invalidateEdgeMap();
    const path = findPath(roads, start, goal, personality);
    self.postMessage({
      type: 'pathResult',
      requestId,
      path: path || null
    });
  } catch (err) {
    console.error('[pathfindingWorker] findPath threw:', err);
    self.postMessage({
      type: 'pathResult',
      requestId,
      path: null,
      error: err?.message || 'Internal pathfinding error'
    });
  }
};

// Notify main thread that the worker is ready and listening (handshake convenience)
self.postMessage({ type: 'ready' });
