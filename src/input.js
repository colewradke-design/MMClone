/**
 * src/input.js
 * Purpose: Pointer and touch event handling on canvas. Converts pixel coordinates to tile coordinates via grid.js immediately on every event. Manages simple drag gesture between adjacent tiles for road toggle intent. Dispatches to injected handlers only — never mutates state or performs game logic. Supports mouse + touch with proper preventDefault. Keyboard 'r' for restart.
 * Expected scale: ~115 LOC. Event wiring, coord conversion, minimal gesture tracking (no allocations in hot path).
 * Imports: ./grid.js (pixelToTile, isValidEdge)
 * Exports: initInput
 *
 * -- Defold equivalent: `on_input` / `on_touch` / `on_key` bindings in a script component; map action_id to messages like `road_toggle` or `restart`.
 */

// -----------------------------------------------------------------------------
// Imports
// -----------------------------------------------------------------------------

import { pixelToTile, isValidEdge } from './grid.js';

/** @typedef {{x: number, y: number}} TileCoord */

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Initializes all input listeners on the provided canvas.
 * Mouse and touch events are wired with {passive:false} for touch to allow preventDefault.
 * A window keydown listener is added for the 'r'/'R' restart hotkey (prototype convenience).
 * Gesture state is local to the closure; automatically resets on mouseleave or up.
 * @param {HTMLCanvasElement} canvas - the game canvas element (must be in DOM for getBoundingClientRect)
 * @param {{ onRoadToggle?: (from: TileCoord, to: TileCoord) => void, onCanvasClick?: (tile: TileCoord) => void, onRestartRequest?: () => void }} [handlers={}] - optional callbacks. All receive only tile coords (never raw pixels).
 */
export function initInput(canvas, handlers = {}) {
  if (!canvas) {
    console.warn('[input.js] initInput called without a valid canvas element');
    return;
  }

  // Private gesture state (reset after each complete interaction)
  let startTile = null;
  let lastTile = null;

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
   * Pointer down / touch start: record the starting tile for potential road gesture.
   * @param {MouseEvent|TouchEvent} e
   */
  function handlePointerDown(e) {
    if (e.type === 'touchstart') {
      e.preventDefault();
    }
    const point = getPointFromEvent(e);
    const tile = pixelToTile(point.x, point.y);
    startTile = { x: tile.x, y: tile.y }; // clone to avoid ref issues
    lastTile = { x: tile.x, y: tile.y };
  }

  /**
   * Pointer move / touch move: update last known tile so up can use accurate end position.
   * Only relevant while a gesture is active.
   * @param {MouseEvent|TouchEvent} e
   */
  function handlePointerMove(e) {
    if (e.type === 'touchmove') {
      e.preventDefault();
    }
    if (!startTile) return;
    const point = getPointFromEvent(e);
    const tile = pixelToTile(point.x, point.y);
    lastTile = { x: tile.x, y: tile.y };
  }

  /**
   * Pointer up / touch end: finalize gesture.
   * - Always fires onCanvasClick (enables "click to restart" when gameOver in main handler)
   * - If start→end forms a valid 8-dir adjacent edge and tiles differ: fires onRoadToggle
   * Resets gesture state afterwards.
   * @param {MouseEvent|TouchEvent} e
   */
  function handlePointerUp(e) {
    if (e.type === 'touchend' || e.type === 'touchcancel') {
      e.preventDefault();
    }
    if (!startTile) return;

    const point = getPointFromEvent(e);
    const endTileFromEvent = pixelToTile(point.x, point.y);

    // Prefer lastTile (updated during move) but fall back to event coords
    const endTile = (lastTile && (lastTile.x !== startTile.x || lastTile.y !== startTile.y))
      ? lastTile
      : endTileFromEvent;

    // 1. Notify raw click/up position (used by main for gameOver restart on simple tap)
    if (handlers.onCanvasClick) {
      handlers.onCanvasClick({ x: endTile.x, y: endTile.y });
    }

    // 2. Notify road gesture only for valid adjacent different tiles
    if (isValidEdge(startTile, endTile) &&
        (startTile.x !== endTile.x || startTile.y !== endTile.y)) {
      if (handlers.onRoadToggle) {
        handlers.onRoadToggle(
          { x: startTile.x, y: startTile.y },
          { x: endTile.x, y: endTile.y }
        );
      }
    }

    // Reset for next interaction
    startTile = null;
    lastTile = null;
  }

  /**
   * Cancels any in-progress gesture if pointer leaves the canvas.
   */
  function handleMouseLeave() {
    startTile = null;
    lastTile = null;
  }

  /**
   * Global key handler: 'r' or 'R' triggers restart request (works even if canvas not focused).
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

  // Future improvement note (not built): return a destroy() fn that removes all listeners
  // if the game ever needs to swap canvases or support multiple sessions.
}