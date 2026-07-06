/**
 * src/input.js
 * Purpose: Pointer and touch event handling on canvas. Converts pixel coordinates to tile coordinates via grid.js immediately on every event. Manages continuous drag gesture for real-time road building: tracks tiles crossed during pointer move, interpolates skipped tiles on fast drags via greedy 8-directional walk, and fires onRoadToggle(A, B) immediately for every new adjacent edge (deduplicated via per-gesture Set). Preserves onCanvasClick on every pointer-up (for tap-to-restart on GAME OVER) and keyboard 'r' restart. Engine-agnostic; only calls injected handlers with tile coords.
 * Expected scale: ~175 LOC. Gesture state + line-walk interpolation + visited edge dedup. No allocations in per-move hot path except small temp objects for walk steps.
 * Imports: ./grid.js (pixelToTile, isValidEdge, isInBounds)
 * Exports: initInput
 *
 * -- Defold equivalent: `on_input` / `on_touch` / `on_key` bindings in a script; dispatch `road_toggle` messages per crossed edge + `restart` on 'r'.
 */

// -----------------------------------------------------------------------------
// Imports
// -----------------------------------------------------------------------------

import { pixelToTile, isValidEdge, isInBounds } from './grid.js';

/** @typedef {{x: number, y: number}} TileCoord */

// -----------------------------------------------------------------------------
// Internal helpers (gesture-local)
// -----------------------------------------------------------------------------

/**
 * Returns a normalized undirected edge key (smaller tile key first).
 * Used only for per-gesture duplicate prevention. Matches the key logic used
 * inside roads.js and vehicles.js for consistency.
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @returns {string}
 */
function getNormalizedEdgeKey(from, to) {
  const fromKey = `${from.x},${from.y}`;
  const toKey = `${to.x},${to.y}`;
  if (fromKey < toKey) {
    return `${fromKey}-${toKey}`;
  }
  return `${toKey}-${fromKey}`;
}

/**
 * Walks from 'from' tile toward 'to' tile using 8-directional steps (preferring
 * diagonal when both axes have distance). Fires onRoadToggle exactly once per
 * new undirected edge via the visitedEdges Set. Stops early if a step would
 * leave the grid or become invalid. Returns the last successfully reached tile
 * (always in-bounds).
 * Called from move handler; small number of iterations even on large jumps.
 * @param {TileCoord} from
 * @param {TileCoord} to
 * @param {Set<string>} visitedEdges
 * @param {{ onRoadToggle?: (from: TileCoord, to: TileCoord) => void }} handlers
 * @returns {TileCoord} last reached tile
 */
function walkFromTo(from, to, visitedEdges, handlers) {
  if (!from || !to) return from;
  let cx = from.x;
  let cy = from.y;
  const tx = to.x;
  const ty = to.y;

  while (cx !== tx || cy !== ty) {
    const dx = Math.sign(tx - cx);
    const dy = Math.sign(ty - cy);
    if (dx === 0 && dy === 0) break;

    let nx = cx;
    let ny = cy;
    if (dx !== 0 && dy !== 0) {
      // diagonal step when both directions needed (natural for 45° drags)
      nx += dx;
      ny += dy;
    } else if (dx !== 0) {
      nx += dx;
    } else {
      ny += dy;
    }

    const next = { x: nx, y: ny };
    if (!isInBounds(next) || !isValidEdge({ x: cx, y: cy }, next)) {
      break; // hit grid boundary or invalid adjacency — stop here
    }

    const edgeKey = getNormalizedEdgeKey({ x: cx, y: cy }, next);
    if (!visitedEdges.has(edgeKey)) {
      visitedEdges.add(edgeKey);
      if (handlers.onRoadToggle) {
        handlers.onRoadToggle({ x: cx, y: cy }, { x: nx, y: ny });
      }
    }

    cx = nx;
    cy = ny;
  }

  return { x: cx, y: cy };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Initializes all input listeners on the provided canvas.
 * Mouse and touch events wired with {passive:false} for touch to allow preventDefault.
 * A window keydown listener is added for the 'r'/'R' restart hotkey.
 * Gesture state (start/last tile + visited edge Set) is local to the closure and
 * automatically reset on mouseleave / up / cancel.
 * @param {HTMLCanvasElement} canvas
 * @param {{ onRoadToggle?: (from: TileCoord, to: TileCoord) => void, onCanvasClick?: (tile: TileCoord) => void, onRestartRequest?: () => void }} [handlers={}]
 */
export function initInput(canvas, handlers = {}) {
  if (!canvas) {
    console.warn('[input.js] initInput called without a valid canvas element');
    return;
  }

  // Private gesture state (reset after each complete interaction)
  let startTile = null;
  let lastTile = null;
  const visitedEdges = new Set();

  /**
   * Extracts canvas-relative pixel coordinates from mouse or touch event.
   * Uses changedTouches for touchend where touches list may be empty.
   * @param {MouseEvent|TouchEvent} e
   * @returns {{x: number, y: number}}
   */
  function getPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    } else {
      clientX = e.clientX ?? 0;
      clientY = e.clientY ?? 0;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  /**
   * Pointer down / touch start: record starting tile and clear visited set for new gesture.
   * @param {MouseEvent|TouchEvent} e
   */
  function handlePointerDown(e) {
    if (e.type === 'touchstart') {
      e.preventDefault();
    }
    const point = getPointFromEvent(e);
    const tile = pixelToTile(point.x, point.y);
    startTile = { x: tile.x, y: tile.y };
    lastTile = { x: tile.x, y: tile.y };
    visitedEdges.clear();
  }

  /**
   * Pointer move / touch move: if gesture active and tile changed, walk from lastTile
   * to new tile (interpolating any skipped tiles) and fire onRoadToggle for each new edge.
   * lastTile is updated to the farthest reachable in-bounds tile.
   * @param {MouseEvent|TouchEvent} e
   */
  function handlePointerMove(e) {
    if (e.type === 'touchmove') {
      e.preventDefault();
    }
    if (!startTile || !lastTile) return;

    const point = getPointFromEvent(e);
    const tile = pixelToTile(point.x, point.y);

    if (tile.x === lastTile.x && tile.y === lastTile.y) return;

    // Walk handles interpolation, bounds clamping, and deduped toggle calls
    lastTile = walkFromTo(lastTile, tile, visitedEdges, handlers);
  }

  /**
   * Pointer up / touch end/cancel: always fire onCanvasClick (enables tap-to-restart on GAME OVER).
   * Road toggles already happened live during the drag via handlePointerMove + walkFromTo.
   * Resets gesture state for next interaction.
   * @param {MouseEvent|TouchEvent} e
   */
  function handlePointerUp(e) {
    if (e.type === 'touchend' || e.type === 'touchcancel') {
      e.preventDefault();
    }
    if (!startTile) return;

    const point = getPointFromEvent(e);
    let endTileFromEvent = pixelToTile(point.x, point.y);

    // Prefer lastTile (the position we actually walked to) when the gesture moved
    let endTile = (lastTile && (lastTile.x !== startTile.x || lastTile.y !== startTile.y))
      ? lastTile
      : endTileFromEvent;

    // Safety: if end position ended up out of bounds, fall back to last known good tile
    if (!isInBounds(endTile)) {
      endTile = lastTile || startTile;
    }

    if (handlers.onCanvasClick) {
      handlers.onCanvasClick({ x: endTile.x, y: endTile.y });
    }

    // Reset for next gesture (visitedEdges cleared on next down)
    startTile = null;
    lastTile = null;
  }

  /**
   * Cancels any in-progress gesture if pointer leaves the canvas.
   */
  function handleMouseLeave() {
    startTile = null;
    lastTile = null;
    visitedEdges.clear();
  }

  /**
   * Global key handler: 'r' or 'R' triggers restart request.
   * @param {KeyboardEvent} e
   */
  function handleKeyDown(e) {
    if (e.key.toLowerCase() === 'r') {
      if (handlers.onRestartRequest) {
        handlers.onRestartRequest();
      }
    }
  }

  // -----------------------------------------------------------------
  // Attach listeners (prototype does not return a teardown function)
  // -----------------------------------------------------------------

  // Mouse
  canvas.addEventListener('mousedown', handlePointerDown);
  canvas.addEventListener('mousemove', handlePointerMove);
  canvas.addEventListener('mouseup', handlePointerUp);
  canvas.addEventListener('mouseleave', handleMouseLeave);

  // Touch (explicit passive:false so preventDefault works)
  canvas.addEventListener('touchstart', handlePointerDown, { passive: false });
  canvas.addEventListener('touchmove', handlePointerMove, { passive: false });
  canvas.addEventListener('touchend', handlePointerUp, { passive: false });
  canvas.addEventListener('touchcancel', handlePointerUp, { passive: false });

  // Keyboard restart hotkey
  window.addEventListener('keydown', handleKeyDown);
}
